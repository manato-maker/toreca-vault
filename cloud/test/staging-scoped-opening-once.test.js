import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyV2 } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';
import { run } from '../scripts/staging-scoped-opening-once.js';

const product = 'Example Card BOX';
const date = '2026-11-22';
const sheetId = 'fake-staging-sheet-id-123456789012345678';
const p = (requestId, store) => ({ type: 'purchase', requestId, product, category: 'BOX',
  quantity: 1, unitCost: 5760, store, date });
const requestId = 'open-existing';
const original = { type: 'open-box', requestId, product, quantity: 2, date,
  memo: 'Shop AとShop Bで購入した各1BOXを開封' };
const sale = { type: 'sale', requestId: 'sold-other', product, category: 'BOX',
  quantity: 1, unitPrice: 9000, date, store: 'Buyer' };

function fixtures() {
  let state = emptyV2();
  for (const cmd of [p('mint', 'Mint'), p('a', 'Shop A'), p('b', 'Shop B'), sale]) {
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
  return { store, queue, provider, spreadsheetId: sheetId, rows };
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
    assert.deepEqual(env.queue.calls, ['enqueue', 'claim', 'finish', 'final']);
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
