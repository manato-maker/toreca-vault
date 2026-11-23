import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyV2 } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';
import { run, assertCommandWorkerPaused, classifyRepairSources, stageRead, scopedReadOnlySheetsToken } from '../scripts/staging-scoped-opening-once.js';

const product = 'Example Card BOX';
const date = '2026-11-22';
const sheetId = 'fake-staging-sheet-id-123456789012345678';
const p = (requestId, store) => ({ type: 'purchase', requestId, product, category: 'BOX',
  quantity: 1, unitCost: 5760, store, date });
const requestId = 'open-existing';
const original = { type: 'open-box', requestId, product, quantity: 2, date,
  memo: 'Shop AとShop Bで購入した各1BOXを開封' };
const sale = { type: 'sale', requestId: 'sold-other', product, category: 'BOX',
  quantity: 1, unitPrice: 9000, date, store: 'Buyer', memo: 'Mint Games source sold' };

function fixtures() {
  let state = emptyV2();
  for (const cmd of [{ ...p('mint', 'Mint'), date: '2026-11-21' }, p('a', 'Shop A'), p('b', 'Shop B'), sale]) {
    state = applyChatCommand(state, cmd).state;
  }
  const rows = new Map([
    [56, [p('a', 'Shop A'), 'v2-applied']],
    [57, [p('b', 'Shop B'), 'v2-applied']],
    [58, [p('mint', 'Mint'), 'v2-applied']],
    [61, [sale, 'v2-applied']],
    [64, [original, 'new']]
  ]);
  let current = { payload: state, revision: state.revision, lastMutationId: state.lastMutationId };
  const provider = {
    writes: [],
    async readRows({ startRow }) {
      const item = rows.get(startRow);
      return item ? [{ rowNumber: startRow,
        values: [item[0].requestId, JSON.stringify(item[0]), '', item[1]] }] : [];
    },
    async writeReceipt(number, receipt, id) {
      assert.equal(number, 64); assert.equal(id, requestId);
      this.writes.push({ ...receipt });
      rows.get(64)[1] = receipt.status;
    }
  };
  let queued = null;
  const queue = {
    calls: [],
    async inspect() { return queued; },
    async enqueue(value) {
      this.calls.push('enqueue');
      assert.equal(value.intakeReceipt.spreadsheetIdHash, createHash('sha256').update(sheetId).digest('hex'));
      assert.equal(value.intakeReceipt.rowNumber, 64);
      assert.deepEqual(value.command, original);
      queued = { status: 'pending', command: value.command };
      return { accepted: true };
    },
    async claim() {
      this.calls.push('claim');
      return { claimed: true, command: original, claimToken: 'lease' };
    },
    async finish(id, token, outcome) {
      this.calls.push('finish');
      assert.equal(token, 'lease');
      queued.status = outcome.outcome;
      return { updated: true };
    },
    async setIntakeReceiptStatus() {
      this.calls.push('final');
      return { updated: true };
    }
  };
  const store = {
    writes: 0,
    async read() { return structuredClone(current); },
    async save({ expectedRevision, mutationId, payload }) {
      assert.equal(expectedRevision, current.revision);
      this.writes++;
      current = { payload: structuredClone(payload), revision: payload.revision, lastMutationId: mutationId };
      return { ...structuredClone(current), duplicate: false };
    },
    inspect() { return structuredClone(current); }
  };
  const backup = () => { queue.calls.push('backup'); };
  return { store, queue, provider, spreadsheetId: sheetId, rows, backup };
}

test('staging repair inspect reads existing rows and never writes anything', async () => {
  const env = fixtures(), lines = [];
  const result = await run({ ...env, apply: false, output: s => lines.push(s) });
  assert.equal(result.status, 'inspect-only');
  assert.equal(env.store.writes, 0);
  assert.equal(env.queue.calls.length, 0);
  assert.equal(env.provider.writes.length, 0);
  assert.match(lines.join('\n'), /READ ONLY/);
  assert.doesNotMatch(lines.join('\n'), /Shop A|Shop B|Mint/);
});

test('staging scoped repair keeps original Intake row, writes exactly once and verifies the receipt', async () => {
  const env = fixtures(), old = process.env.TV_STAGING_REPAIR_APPROVED;
  process.env.TV_STAGING_REPAIR_APPROVED = 'true';
  try {
    const result = await run({ ...env, apply: true, expectedRevision: 4, output: () => {} });
    assert.equal(result.status, 'canonical-readback-verified');
    assert.equal(result.revision, 5);
    assert.equal(env.store.writes, 1);
    assert.deepEqual(env.queue.calls, ['backup', 'enqueue', 'claim', 'finish', 'final']);
    assert.deepEqual(env.provider.writes.map(r => r.status), ['queued', 'v2-applied']);
    assert.equal(env.rows.get(64)[0].requestId, requestId);
    assert.equal(env.store.inspect().payload.transactions.filter(tx => tx.id === 'chat-opening-' + requestId).length, 1);
  } finally {
    if (old === undefined) delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED = old;
  }
});

test('staging apply does not queue original request when approval or revision is missing', async () => {
  const env = fixtures(), old = process.env.TV_STAGING_REPAIR_APPROVED;
  delete process.env.TV_STAGING_REPAIR_APPROVED;
  try {
    await assert.rejects(() => run({ ...env, apply: true, expectedRevision: 4, output: () => {} }), /approval/);
    assert.equal(env.queue.calls.length, 0);
    process.env.TV_STAGING_REPAIR_APPROVED = 'true';
    await assert.rejects(() => run({ ...env, apply: true, expectedRevision: 3, output: () => {} }), /revision/);
    assert.equal(env.queue.calls.length, 0);
  } finally {
    if (old === undefined) delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED = old;
  }
});

test('scoped repair requires the precise command worker Scheduler to be paused', () => {
  const url = 'https://toreca-vault-staging-235108293761.asia-northeast1.run.app';
  const job = { state: 'ENABLED', httpTarget: { uri: url + '/internal/worker/commands', httpMethod: 'POST' } };
  assert.throws(() => assertCommandWorkerPaused([], url), /PAUSED/);
  assert.throws(() => assertCommandWorkerPaused([job], url), /PAUSED/);
  assert.throws(() => assertCommandWorkerPaused([{ ...job, state: 'PAUSED', httpTarget: { ...job.httpTarget, uri: url + '/other' } }], url), /PAUSED/);
  assert.throws(() => assertCommandWorkerPaused([job, { ...job, state: 'PAUSED' }], url), /PAUSED/);
  assert.doesNotThrow(() => assertCommandWorkerPaused([{ ...job, state: 'PAUSED' }], url));
});

test('read-only diagnosis identifies historically wrong FIFO sale provenance without exposing identities', async () => {
  const env = fixtures();
  // Simulate equal-date purchases and the generic FIFO sale taking target-a
  // instead of Mint. This is the reason explicit source matching is mandatory.
  let state = emptyV2();
  for (const cmd of [p('mint', 'Mint'), p('a', 'Shop A'), p('b', 'Shop B'), sale]) {
    state = applyChatCommand(state, cmd).state;
  }
  const stale = { payload: state, revision: state.revision, lastMutationId: state.lastMutationId };
  env.store.read = async () => structuredClone(stale);
  const diag = classifyRepairSources({
    canonical: stale,
    purchaseRows: [56, 57].map(n => ({ rowNumber: n, values: [env.rows.get(n)[0].requestId,
      JSON.stringify(env.rows.get(n)[0]), '', 'v2-applied'] })),
    excludedPurchaseRow: { rowNumber: 58, values: [env.rows.get(58)[0].requestId,
      JSON.stringify(env.rows.get(58)[0]), '', 'v2-applied'] }
  });
  assert.deepEqual(diag.targets, ['missing', 'present-and-matched']);
  assert.equal(diag.excluded, 'present-and-matched');
  const log = [];
  const inspected = await run({ ...env, apply: false, output: line => log.push(line) });
  assert.equal(inspected.status, 'inspect-only');
  assert.match(log.join('\n'), /Source lot 1: missing/);
  assert.match(log.join('\n'), /Historical sale provenance correction planned: true/);
  assert.doesNotMatch(log.join('\n'), /Shop A|Shop B|Mint/);
  assert.equal(env.store.writes, 0);
  assert.equal(env.provider.writes.length, 0);
  assert.deepEqual(env.queue.calls, []);
});

test('historical FIFO source correction needs an independent authorization', async () => {
  const env = fixtures();
  let state = emptyV2();
  for (const cmd of [p('mint', 'Mint'), p('a', 'Shop A'), p('b', 'Shop B'), sale]) {
    state = applyChatCommand(state, cmd).state;
  }
  env.store.read = async () => structuredClone({ payload: state, revision: state.revision,
    lastMutationId: state.lastMutationId });
  const approved = process.env.TV_STAGING_REPAIR_APPROVED;
  const provenance = process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  process.env.TV_STAGING_REPAIR_APPROVED = 'true';
  delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  try {
    await assert.rejects(() => run({ ...env, apply: true, expectedRevision: state.revision,
      output: () => {} }), /separate historical sale provenance repair approval/);
    assert.equal(env.store.writes, 0);
    assert.deepEqual(env.queue.calls, []);
    assert.equal(env.provider.writes.length, 0);
  } finally {
    if (approved === undefined) delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED = approved;
    if (provenance === undefined) delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
    else process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED = provenance;
  }
});

test('historical FIFO correction moves sold-source attribution and opens only the target boxes', async () => {
  const env = fixtures();
  let state = emptyV2();
  for (const cmd of [p('mint', 'Mint'), p('a', 'Shop A'), p('b', 'Shop B'), sale]) {
    state = applyChatCommand(state, cmd).state;
  }
  const originalPurchases = state.transactions.filter(tx => tx.type === 'purchase').map(tx => structuredClone(tx));
  let current = { payload: state, revision: state.revision, lastMutationId: state.lastMutationId };
  env.store.read = async () => structuredClone(current);
  env.store.save = async ({ expectedRevision, mutationId, payload }) => {
    assert.equal(expectedRevision, current.revision);
    env.store.writes += 1;
    current = { payload: structuredClone(payload), revision: payload.revision, lastMutationId: mutationId };
    return { ...structuredClone(current), duplicate: false };
  };
  const approved = process.env.TV_STAGING_REPAIR_APPROVED;
  const provenance = process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  process.env.TV_STAGING_REPAIR_APPROVED = 'true';
  process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED = 'true';
  try {
    const result = await run({ ...env, apply: true, expectedRevision: 4, output: () => {} });
    assert.equal(result.status, 'canonical-readback-verified');
    assert.equal(env.store.writes, 1);
    assert.equal(current.payload.inventoryLots.length, 0);
    assert.deepEqual(current.payload.transactions.filter(tx => tx.type === 'purchase'), originalPurchases);
    assert.equal(current.payload.transactions.find(tx => tx.id === 'chat-sale-sold-other').sourcePurchaseRequestId, 'mint');
    const opening = current.payload.transactions.find(tx => tx.id === 'chat-opening-open-existing');
    assert.equal(opening.acquisitionCost, 11520);
    assert.deepEqual(opening.sourcePurchaseRequestIds, ['a','b']);
    assert.equal(opening.reconciledSoldPurchaseRequestId, 'mint');
    assert.equal(env.provider.writes.at(-1).status, 'v2-applied');
  } finally {
    if (approved === undefined) delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED = approved;
    if (provenance === undefined) delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
    else process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED = provenance;
  }
});

test('diagnostic stages identify IAM and auth problems but never leak private exception text', async () => {
  for (const [code, expected] of [[401, 'unauthenticated'], [403, 'permission denied'],
    [404, 'missing resource'], [429, 'quota'], [14, 'unavailable']]) {
    await assert.rejects(() => stageRead('Firestore canonical snapshot read', () => {
      const error = new Error('LEAK_PRIVATE_BEARER_TOKEN_AND_CUSTOMER_NAME');
      error.code = code;
      throw error;
    }), error => {
      assert.match(error.message, /Firestore canonical snapshot read/);
      assert.match(error.message, new RegExp(expected));
      assert.doesNotMatch(error.message, /LEAK_PRIVATE/);
      return true;
    });
  }
});

test('read-only inspect reports Intake, queue and canonical failure locations safely', async () => {
  for (const [stage, mutate] of [
    ['Intake Sheets source-row read', env => {
      env.provider.readRows = async () => { throw new Error('LEAK_PRIVATE_SHEET_ID'); };
    }],
    ['Firestore command queue lookup', env => {
      env.queue.inspect = async () => { const e = new Error('LEAK_PRIVATE_QUEUE_KEY'); e.code=7; throw e; };
    }],
    ['Firestore canonical snapshot read', env => {
      env.store.read = async () => { const e = new Error('LEAK_PRIVATE_CANONICAL'); e.code=16; throw e; };
    }]
  ]) {
    const env = fixtures();
    mutate(env);
    await assert.rejects(() => run({ ...env, apply: false, output: () => {} }), error => {
      assert.match(error.message, new RegExp(stage));
      assert.doesNotMatch(error.message, /LEAK_PRIVATE/);
      return true;
    });
    assert.equal(env.store.writes, 0);
    assert.equal(env.provider.writes.length, 0);
    assert.deepEqual(env.queue.calls, []);
  }
});

test('missing application-default login is classified without printing the credential error', async () => {
  await assert.rejects(() => stageRead('Intake Sheets source-row read', () => {
    throw new Error('Could not load the default credentials. LEAK_PRIVATE_ACCOUNT');
  }), error => {
    assert.match(error.message, /application-default credentials missing/);
    assert.doesNotMatch(error.message, /LEAK_PRIVATE_ACCOUNT/);
    return true;
  });
  await assert.rejects(() => stageRead('Intake Sheets source-row read', () => {
    throw new Error('Request had insufficient authentication scopes LEAK_TOKEN');
  }), error => {
    assert.match(error.message, /OAuth scope insufficient/);
    assert.doesNotMatch(error.message, /LEAK_TOKEN/);
    return true;
  });
});

test('Sheets HTTP 403 from the real adapter is shown as sanitized permission failure', async () => {
  const { createGoogleSheetsIntakeProvider } = await import('../src/google-sheets-intake-provider.js');
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: '1abcdefghijklmnopqrstuvwxyz0123456789',
    getAccessToken: async () => 'synthetic-private-token',
    fetchImpl: async () => new Response('private sheet details and tokens', {status: 403})
  });
  await assert.rejects(() => stageRead('Intake Sheets source-row read',
    () => provider.readRows({startRow:64,limit:1})), error => {
    assert.match(error.message, /permission denied/);
    assert.doesNotMatch(error.message, /private sheet details|synthetic-private-token/);
    return true;
  });
});

test('inspect-only runtime service token asks only for 10-minute Sheets read-only scope', async () => {
  const cliCalls = [], calls = [];
  const runtimeIdentity = 'runtime@project-123.iam.gserviceaccount.com';
  const token = await scopedReadOnlySheetsToken({
    runtimeIdentity,
    cliFn: (...args) => {
      cliCalls.push(args);
      return 'operator-token-example-fake-123456789012';
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accessToken: 'short-lived-scoped-example-123456789012' }),
        { status: 200 });
    }
  });
  assert.equal(token, 'short-lived-scoped-example-123456789012');
  assert.deepEqual(cliCalls, [['auth', 'print-access-token']]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /iamcredentials.googleapis.com\/v1\/projects\/-\/serviceAccounts\//);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    lifetime: '600s'
  });
  assert.doesNotMatch(calls[0].init.body, /cloud-platform|datastore|spreadsheets"\]/);
});

test('short-lived Sheets fallback fails closed without user impersonation rights or private response bodies', async () => {
  const params = {
    runtimeIdentity: 'runtime@project-123.iam.gserviceaccount.com',
    cliFn: () => 'operator-token-example-fake-123456789012'
  };
  await assert.rejects(() => scopedReadOnlySheetsToken({
    ...params,
    fetchImpl: async () => new Response('SECRET-PRIVATE-SHEET-IDENTITY', { status: 403 })
  }), error => {
    assert.match(error.message, /permission denied/);
    assert.doesNotMatch(error.message, /SECRET-PRIVATE/);
    return true;
  });
  await assert.rejects(() => scopedReadOnlySheetsToken({
    ...params,
    runtimeIdentity: 'wrong/improper@project-123.iam.gserviceaccount.com',
    fetchImpl: async () => { throw new Error('should not call'); }
  }), /unverified/);
});
