import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGoogleSheetsIntakeStatusProcessor } from '../src/google-sheets-intake-status.js';

const sha = (value) => value.repeat(64).slice(0, 64);
const spreadsheetId = '1abcdefghijklmnopqrstuvwxyz0123456789';
const spreadsheetIdHash = createHash('sha256').update(spreadsheetId).digest('hex');
const requestHash = (value) => createHash('sha256').update(value).digest('hex');

function makeQueue(rows) {
  const writes = [];
  return {
    writes,
    async listIntakeReceipts() { return rows.map((row) => ({ ...row.ref })); },
    async inspectByRequestIdHash(hash) { return rows.find((row) => row.ref.requestIdHash === hash)?.queueRow || null; },
    async setIntakeReceiptStatus(requestId, input) { writes.push({ requestId, ...input }); return { updated: true }; }
  };
}

test('intake status reconciliation distinguishes V2 readback verified, duplicate, and review', async () => {
  const rows = [
    { ref: { requestId: 'sheet:1', requestIdHash: requestHash('sheet:1'), spreadsheetIdHash, rowNumber: 2 }, queueRow: { requestId: 'sheet:1', status: 'processing', updatedAtMs: 200 } },
    { ref: { requestId: 'sheet:2', requestIdHash: requestHash('sheet:2'), spreadsheetIdHash, rowNumber: 3 }, queueRow: { requestId: 'sheet:2', status: 'done', resultCode: 'v2-applied', updatedAtMs: 300 } },
    { ref: { requestId: 'sheet:3', requestIdHash: requestHash('sheet:3'), spreadsheetIdHash, rowNumber: 4 }, queueRow: { requestId: 'sheet:3', status: 'done', resultCode: 'duplicate-already-applied', updatedAtMs: 400 } },
    { ref: { requestId: 'sheet:4', requestIdHash: requestHash('sheet:4'), spreadsheetIdHash, rowNumber: 5 }, queueRow: { requestId: 'sheet:4', status: 'review', resultCode: 'command-invalid', updatedAtMs: 500 } },
    { ref: { requestId: 'sheet:5', requestIdHash: requestHash('sheet:5'), spreadsheetIdHash, rowNumber: 6 }, queueRow: { requestId: 'sheet:5', status: 'pending', updatedAtMs: 600 } }
  ];
  const queue = makeQueue(rows);
  const receipts = [];
  const run = createGoogleSheetsIntakeStatusProcessor({
    provider: { async writeReceipt(rowNumber, receipt) { receipts.push({ rowNumber, ...receipt }); } },
    queue,
    spreadsheetId,
    now: () => 1000
  });
  assert.deepEqual(await run(), { checked: 5, finalized: 3, pending: 2 });
  assert.deepEqual(receipts, [
    { rowNumber: 3, status: 'v2-applied', resultCode: 'canonical-readback-verified', acceptedRequestId: 'sheet:2', processedAtMs: 300 },
    { rowNumber: 4, status: 'duplicate', resultCode: 'already-applied-verified', acceptedRequestId: 'sheet:3', processedAtMs: 400 },
    { rowNumber: 5, status: 'review', resultCode: 'command-invalid', acceptedRequestId: 'sheet:4', processedAtMs: 500 }
  ]);
  assert.deepEqual(queue.writes.map(({ requestId, state }) => ({ requestId, state })), [
    { requestId: 'sheet:2', state: 'final' },
    { requestId: 'sheet:3', state: 'final' },
    { requestId: 'sheet:4', state: 'final' }
  ]);
});

test('receipt write/readback failure leaves queue correlation pending for retry', async () => {
  const row = { ref: { requestId: 'sheet:retry', requestIdHash: requestHash('sheet:retry'), spreadsheetIdHash, rowNumber: 2 }, queueRow: { requestId: 'sheet:retry', status: 'done', resultCode: 'v2-applied', updatedAtMs: 300 } };
  const queue = makeQueue([row]);
  const run = createGoogleSheetsIntakeStatusProcessor({
    provider: { async writeReceipt() { throw new Error('private network error'); } },
    queue,
    spreadsheetId
  });
  await assert.rejects(run(), /private network error/);
  assert.deepEqual(queue.writes, []);
});

test('status worker rejects malformed references before touching Sheets', async () => {
  let calls = 0;
  const run = createGoogleSheetsIntakeStatusProcessor({
    provider: { async writeReceipt() { calls++; } },
    queue: {
      async listIntakeReceipts() { return [{ requestId: 'bad', requestIdHash: 'short', spreadsheetIdHash, rowNumber: 2 }]; },
      async inspectByRequestIdHash() { return null; },
      async setIntakeReceiptStatus() { return { updated: true }; }
    },
    spreadsheetId
  });
  await assert.rejects(run(), /invalid intake receipt reference/);
  assert.equal(calls, 0);
});
