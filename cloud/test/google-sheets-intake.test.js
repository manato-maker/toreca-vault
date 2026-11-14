import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleSheetsIntakeProcessor } from '../src/google-sheets-intake.js';

const spreadsheetId = '1abcdefghijklmnopqrstuvwxyz0123456789';

function row(requestId, command, identity = '', status = 'new', rowNumber = 2) {
  return { rowNumber, values: [requestId, JSON.stringify(command), identity, status] };
}

function fakeProvider(rows) {
  const receipts = [], sourceIds = [];
  return {
    receipts, sourceIds,
    async readRows() { return rows; },
    async writeReceipt(rowNumber, receipt, sourceRequestId) {
      receipts.push({ rowNumber, ...receipt });
      sourceIds.push(sourceRequestId);
    }
  };
}

function fakeCursorStore(startRow = 2) {
  let nextRow = startRow;
  return {
    async read() { return { nextRow }; },
    async advance({ expectedNextRow, nextRow: updatedNextRow }) {
      if (nextRow !== expectedNextRow) return false;
      nextRow = updatedNextRow;
      return true;
    },
    current() { return nextRow; }
  };
}

test('new purchase row enqueues once and writes only a bounded receipt', async () => {
  const command = { requestId: 'sheet:purchase:1', type: 'purchase', product: '30th CELEBRATION', quantity: 1 };
  const provider = fakeProvider([row(command.requestId, command)]);
  const calls = [];
  const run = createGoogleSheetsIntakeProcessor({
    provider,
    queue: { async enqueue(input) { calls.push(input); return { accepted: true, duplicate: false, status: 'pending' }; } },
    cursorStore: fakeCursorStore(),
    spreadsheetId,
    now: () => 1234
  });
  assert.deepEqual(await run(), { seen: 1, enqueued: 1, duplicate: 0, review: 0, skipped: 0 });
  assert.deepEqual(calls, [{ requestId: command.requestId, command, businessEventKey: undefined, intakeReceipt: {
    spreadsheetIdHash: '263121001d5d1165c7c80fcf4c1a0ccf8e945aabb4fdb571af00ab028d9145f1', rowNumber: 2
  } }]);
  assert.deepEqual(provider.receipts, [{
    rowNumber: 2, status: 'queued', resultCode: 'accepted', acceptedRequestId: command.requestId, processedAtMs: 1234
  }]);
  assert.equal(JSON.stringify(provider.receipts).includes('30th CELEBRATION'), false);
});

test('retries use the same durable request ID and a repeated explicit lottery identity deduplicates across IDs', async () => {
  const identity = JSON.stringify({ retailerKey: 'イトーヨーカドー アリオ八尾店', applicationId: 'entry-123' });
  const first = { requestId: 'chat:lottery:1', type: 'lottery', title: '30th', store: 'イトーヨーカドー アリオ八尾店' };
  const second = { ...first, requestId: 'gmail:lottery:2' };
  const provider = fakeProvider([row(first.requestId, first, identity, 'new', 2), row(second.requestId, second, identity, 'new', 3)]);
  const events = new Map();
  const queue = {
    async enqueue(input) {
      if (events.has(input.businessEventKey)) {
        return { accepted: false, duplicate: true, businessDuplicate: true, existingRequestId: events.get(input.businessEventKey) };
      }
      events.set(input.businessEventKey, input.requestId);
      return { accepted: true, duplicate: false, status: 'pending' };
    }
  };
  const cursorStore = fakeCursorStore();
  const run = createGoogleSheetsIntakeProcessor({ provider, queue, cursorStore, spreadsheetId, now: () => 2000 });
  assert.deepEqual(await run(), { seen: 2, enqueued: 1, duplicate: 1, review: 0, skipped: 0 });
  assert.equal(cursorStore.current(), 4);
  assert.match(provider.receipts[1].resultCode, /duplicate/);
  assert.equal(provider.receipts[1].acceptedRequestId, first.requestId);
  assert.deepEqual(provider.sourceIds, [first.requestId, second.requestId]);
});

test('malformed commands, mismatched IDs, and missing lottery IDs route to review without queue calls', async () => {
  const provider = fakeProvider([
    { rowNumber: 2, values: ['sheet:bad:json', '{', '', 'new'] },
    row('sheet:bad:mismatch', { requestId: 'other-id', type: 'purchase' }, '', 'new', 3),
    row('sheet:lottery:noid', { requestId: 'sheet:lottery:noid', type: 'lottery' }, JSON.stringify({ retailerKey: 'store-a' }), 'new', 4),
    row('sheet:lottery:missing', { requestId: 'sheet:lottery:missing', type: 'lottery' }, '', 'new', 5)
  ]);
  let queueCalls = 0;
  const cursorStore = fakeCursorStore();
  const run = createGoogleSheetsIntakeProcessor({ provider, queue: { async enqueue() { queueCalls++; } }, cursorStore, spreadsheetId, now: () => 3000 });
  assert.deepEqual(await run(), { seen: 4, enqueued: 0, duplicate: 0, review: 4, skipped: 0 });
  assert.equal(queueCalls, 0);
  assert.deepEqual(provider.receipts.map((item) => item.status), ['review', 'review', 'review', 'review']);
  assert.ok(provider.receipts.every((item) => !JSON.stringify(item).includes('entry ID')));
  assert.deepEqual(provider.sourceIds, [
    'sheet:bad:json', 'sheet:bad:mismatch', 'sheet:lottery:noid', 'sheet:lottery:missing'
  ]);
});

test('only explicit new rows are processed and batch bounds are enforced', async () => {
  const provider = fakeProvider([row('sheet:done:1', { requestId: 'sheet:done:1', type: 'purchase' }, '', 'queued')]);
  let queueCalls = 0;
  const run = createGoogleSheetsIntakeProcessor({ provider, queue: { async enqueue() { queueCalls++; } }, cursorStore: fakeCursorStore(), spreadsheetId });
  assert.deepEqual(await run(), { seen: 0, enqueued: 0, duplicate: 0, review: 0, skipped: 1 });
  assert.equal(queueCalls, 0);
  assert.throws(() => createGoogleSheetsIntakeProcessor({ provider, queue: { enqueue() {} }, cursorStore: fakeCursorStore(), spreadsheetId, maxRowsPerRun: 51 }), /from 1 to 50/);
});

test('a queue failure leaves the row retryable and does not mark it processed', async () => {
  const command = { requestId: 'sheet:retry:1', type: 'purchase' };
  const provider = fakeProvider([row(command.requestId, command)]);
  const cursorStore = fakeCursorStore();
  const run = createGoogleSheetsIntakeProcessor({ provider, queue: { async enqueue() { throw new Error('sensitive details'); } }, cursorStore, spreadsheetId });
  await assert.rejects(run(), /Google Sheets command enqueue failed/);
  assert.deepEqual(provider.receipts, []);
  assert.equal(cursorStore.current(), 2);
});


test('confirmed Chat lottery without external application ID has a conservative fingerprint and can enqueue once', async () => {
  const common = {
    type: 'lottery', title: '公式商品A 抽選', store: '店舗A',
    owner: '本人分', applicationDate: '2026-11-14',
    status: '応募済', evidenceType: 'screenshot', quantity: 2
  };
  const first = { ...common, requestId: 'chat:confirmed:lottery:1' };
  const second = { ...common, requestId: 'chat:confirmed:lottery:2', quantity: 1 };
  const inputs = [];
  const existing = new Map();
  const provider = fakeProvider([
    row(first.requestId, first, '', 'new', 2),
    row(second.requestId, second, '', 'new', 3)
  ]);
  const run = createGoogleSheetsIntakeProcessor({
    provider, spreadsheetId, cursorStore: fakeCursorStore(), now: () => 123,
    queue: { async enqueue(input) {
      inputs.push(input);
      if (existing.has(input.businessEventKey)) {
        return { businessDuplicate: true, existingRequestId: existing.get(input.businessEventKey) };
      }
      existing.set(input.businessEventKey, input.requestId);
      return { accepted: true };
    } }
  });
  assert.deepEqual(await run(), { seen: 2, enqueued: 1, duplicate: 1, review: 0, skipped: 0 });
  assert.match(inputs[0].businessEventKey, /^lottery:confirmed-report:v1:[a-f0-9]{64}$/);
  assert.equal(inputs[0].businessEventKey, inputs[1].businessEventKey);
  assert.equal(provider.receipts[1].status, 'duplicate');
  assert.deepEqual(provider.sourceIds, [first.requestId, second.requestId]);
});

test('unconfirmed or insufficiently identified Chat lottery never gets a fingerprint', async () => {
  const base = { requestId: 'chat:lottery:no-evidence', type: 'lottery',
    title: '商品A', store: '店舗A', owner: '本人分',
    applicationDate: '2026-11-14', status: '応募済' };
  const invalid = [
    { ...base },
    { ...base, evidenceType: 'screenshot', owner: '' },
    { ...base, evidenceType: 'chat-report', applicationDate: '' },
    { ...base, evidenceType: 'screenshot', applicationDate: '2026-02-31' },
    { ...base, evidenceType: 'chat-report', status: '応募前' }
  ];
  const provider = fakeProvider(invalid.map((command, index) => row(command.requestId, command, '', 'new', index + 2)));
  let queueCalls = 0;
  const run = createGoogleSheetsIntakeProcessor({
    provider, spreadsheetId, cursorStore: fakeCursorStore(), now: () => 4,
    queue: { async enqueue() { queueCalls++; } }
  });
  assert.deepEqual(await run(), { seen: 5, enqueued: 0, duplicate: 0, review: 5, skipped: 0 });
  assert.equal(queueCalls, 0);
  assert.ok(provider.receipts.every(x => x.resultCode === 'lottery-identity-missing'));
});


test('legacy matching kind field is accepted for an exact lottery receipt without relaxing identity safety', async () => {
  const requestId = 'chat:legacy:receipt:1';
  const command = { requestId, type: 'lottery-receipt', title: '抽選A', store: '公式店', receivedDate: '2026-11-13' };
  const identity = JSON.stringify({ kind: 'receipt', retailerKey: 'pokemoncenter-online', applicationId: 'entry-2026-1' });
  const provider = fakeProvider([row(requestId, command, identity)]);
  const enqueued = [];
  const run = createGoogleSheetsIntakeProcessor({
    provider, spreadsheetId, cursorStore: fakeCursorStore(), now: () => 200,
    queue: { async enqueue(x) { enqueued.push(x); return { accepted: true }; } }
  });
  assert.equal((await run()).enqueued, 1);
  assert.equal(enqueued[0].requestId, requestId);
  assert.match(enqueued[0].businessEventKey, /^lottery:v1:[a-f0-9]{64}$/);
  assert.equal(provider.receipts[0].status, 'queued');
});

test('mismatched legacy kind is reviewed, not turned into a different lottery event', async () => {
  const requestId = 'chat:legacy:kind-mismatch';
  const command = { requestId, type: 'lottery-receipt', title: '抽選A', store: '公式店', receivedDate: '2026-11-13' };
  const identity = JSON.stringify({ kind: 'application', retailerKey: 'pokemoncenter-online', applicationId: 'entry-2026-1' });
  const provider = fakeProvider([row(requestId, command, identity)]);
  let queueCalls = 0;
  const run = createGoogleSheetsIntakeProcessor({
    provider, spreadsheetId, cursorStore: fakeCursorStore(), now: () => 200,
    queue: { async enqueue() { queueCalls++; } }
  });
  assert.equal((await run()).review, 1);
  assert.equal(provider.receipts[0].resultCode, 'lottery-kind-mismatch');
  assert.equal(queueCalls, 0);
});


test('a retry after queue acceptance but before Sheets receipt does not mislabel the report terminal duplicate', async () => {
  const command = { requestId: 'chat:purchase:interrupted', type: 'purchase', product: '商品A', quantity: 1 };
  const provider = fakeProvider([row(command.requestId, command)]);
  const run = createGoogleSheetsIntakeProcessor({
    provider, spreadsheetId, cursorStore: fakeCursorStore(), now: () => 5000,
    queue: { async enqueue() { return { accepted: true, duplicate: true, status: 'pending' }; } }
  });
  assert.deepEqual(await run(), { seen: 1, enqueued: 0, duplicate: 1, review: 0, skipped: 0 });
  assert.deepEqual(provider.receipts[0], {
    rowNumber: 2, status: 'queued', resultCode: 'accepted',
    acceptedRequestId: command.requestId, processedAtMs: 5000
  });
  assert.equal(provider.sourceIds[0], command.requestId);
});
