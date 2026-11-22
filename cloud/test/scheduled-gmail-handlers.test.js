import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledGmailHandlers } from '../src/scheduled-gmail-handlers.js';

function fakeCheckpointStore() {
  const values = new Map();
  return {
    values,
    async load(type) { return values.get(type) || null; },
    async saveCursor(type, cursor) { values.set(type, { cursor, lastSuccessfulAtMs: values.get(type)?.lastSuccessfulAtMs ?? null }); },
    async completeScan(type, lastSuccessfulAtMs) { values.set(type, { cursor: null, lastSuccessfulAtMs }); }
  };
}

function setup() {
  const checkpoints = fakeCheckpointStore();
  const requests = [];
  const handlers = createScheduledGmailHandlers({
    provider: { async listMessages(query, options) {
      requests.push({ query, options });
      return { messages: [], nextPageToken: null };
    } },
    checkpointStore: checkpoints,
    ledger: { async claim() {}, async complete() {}, async fail() {} },
    processMessage: async () => {},
    clock: () => Date.parse('2026-11-07T20:00:00+09:00')
  });
  return { handlers, checkpoints, requests };
}

test('hourly 19:00 handler uses the planned slot and keeps result terms in the single query', async () => {
  const { handlers, checkpoints, requests } = setup();
  await handlers['gmail-lottery-inbox']({
    kind: 'gmail-lottery-inbox', jobKey: 'gmail-lottery-inbox:2026-11-07T19:00+09:00',
    scheduledAt: '2026-11-07T19:00+09:00', focusResults: true
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].query, /抽選/);
  assert.match(requests[0].query, /当選/);
  assert.equal(checkpoints.values.has('hourly'), true);
  assert.equal(checkpoints.values.has('results'), false);
});

test('12:30 result focus catch-up extends its fixed scan to the actual trigger time', async () => {
  const { handlers, checkpoints, requests } = setup();
  await handlers['lottery-result-focus']({
    kind: 'lottery-result-focus', jobKey: 'lottery-result-focus:2026-11-07',
    scheduledAt: '2026-11-07T12:30+09:00', triggeredAt: '2026-11-07T18:45:00+09:00', catchUp: true
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].query, /\{当選 落選 抽選結果\}/);
  assert.ok(requests[0].query.includes(`before:${Math.floor(Date.parse('2026-11-07T18:45:00+09:00') / 1000) + 1}`));
  assert.equal(checkpoints.values.has('results'), true);
  assert.equal(checkpoints.values.has('hourly'), false);
});

test('scheduled Gmail handlers reject misrouted jobs and page sizes above the API safety cap', async () => {
  const { handlers } = setup();
  await assert.rejects(handlers['gmail-lottery-inbox']({
    kind: 'lottery-result-focus', jobKey: 'bad', scheduledAt: '2026-11-07T19:00+09:00'
  }), /hourly Gmail job/);
  assert.throws(() => createScheduledGmailHandlers({
    provider: { listMessages() {} }, checkpointStore: fakeCheckpointStore(),
    ledger: { claim() {} }, processMessage() {}, maxResults: 51
  }), /maxResults/);
});
