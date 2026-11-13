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
