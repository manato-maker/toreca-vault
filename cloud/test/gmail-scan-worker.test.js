import test from 'node:test';
import assert from 'node:assert/strict';
import { runGmailScanPage } from '../src/gmail-scan-worker.js';

function fakeLedger() {
  const completed = new Set();
  let lease = 0;
  return {
    completed,
    async claim(key) {
      return completed.has(key) ? { claimed: false, status: 'completed' } : { claimed: true, claimToken: String(++lease) };
    },
    async complete(key) { completed.add(key); return { status: 'completed' }; },
    async fail() { return { status: 'retry' }; }
  };
}

function checkpointStore(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async load(scanType) { return structuredClone(values[scanType] || null); },
    async saveCursor(scanType, cursor) {
      values[scanType] = { ...(values[scanType] || {}), cursor };
    },
    async saveLastSuccessfulAt(scanType, lastSuccessfulAtMs) {
      values[scanType] = { ...(values[scanType] || {}), lastSuccessfulAtMs };
    }
  };
}

test('Gmail scan worker checkpoints next page only after every message job completes', async () => {
  const checkpoints = checkpointStore();
  const out = await runGmailScanPage({
    provider: { async listMessages(_query, options) {
      assert.equal(options.maxResults, 2);
      return { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'page-2' };
    } },
    checkpointStore: checkpoints,
    ledger: fakeLedger(),
    processMessage: async (job) => { assert.ok(job.messageId); },
    nowMs: 1_800_000_000_000,
    maxResults: 2,
    clock: () => 100
  });
  assert.equal(out.fetched, 2);
  assert.equal(checkpoints.values.hourly.cursor.pageToken, 'page-2');
  assert.equal(checkpoints.values.hourly.lastSuccessfulAtMs, undefined);
});

test('Gmail scan worker does not advance a cursor after a failed or busy message job', async () => {
  const checkpoints = checkpointStore();
  await assert.rejects(runGmailScanPage({
    provider: { async listMessages() { return { messages: [{ id: 'm1' }], nextPageToken: 'page-2' }; } },
    checkpointStore: checkpoints,
    ledger: { async claim() { return { claimed: true, claimToken: 'lease' }; }, async complete() {}, async fail() { return { status: 'retry' }; } },
    processMessage: async () => { throw new Error('provider failure'); },
    nowMs: 1_800_000_000_000,
    clock: () => 100
  }), /uncompleted message jobs/);
  assert.equal(checkpoints.values.hourly, undefined);
});

test('Gmail scan worker stores the last-success time only after the final page', async () => {
  const nowMs = 1_800_000_000_000;
  const checkpoints = checkpointStore({ hourly: { cursor: { sinceMs: nowMs - 60_000, untilMs: nowMs, scanType: 'hourly', pageToken: 'last' } } });
  const out = await runGmailScanPage({
    provider: { async listMessages(_query, options) {
      assert.equal(options.pageToken, 'last');
      return { messages: [] };
    } },
    checkpointStore: checkpoints,
    ledger: fakeLedger(),
    processMessage: async () => {},
    nowMs,
    clock: () => 100
  });
  assert.equal(out.checkpoint.complete, true);
  assert.equal(checkpoints.values.hourly.cursor, null);
  assert.equal(checkpoints.values.hourly.lastSuccessfulAtMs, nowMs);
});
