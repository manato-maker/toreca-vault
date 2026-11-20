import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';
import { runGmailScanPage } from '../src/gmail-scan-worker.js';

test('Gmail scan persists classification before completing message job and checkpoint', async () => {
  const events = [];
  const checkpointStore = {
    async load() { return null; },
    async saveCursor(_scanType, cursor) { events.push(['save-cursor', cursor]); },
    async completeScan(_scanType, at) { events.push(['complete-scan', at]); }
  };
  const ledger = {
    async claim(jobKey) {
      events.push(['claim', jobKey]);
      return { claimed: true, status: 'claimed', claimToken: 'lease-1' };
    },
    async complete(jobKey, _token) {
      events.push(['complete-job', jobKey]);
      return { status: 'completed', duplicate: false };
    },
    async fail() { assert.fail('successful classification must not fail the job'); }
  };
  const provider = {
    async listMessages() {
      events.push(['list']);
      return { messages: [{ id: 'mail-id-1' }], nextPageToken: null };
    },
    async getMessageForClassification(messageId) {
      events.push(['read-message', messageId]);
      return { subject: 'ポケモンカード 抽選結果', text: 'winner body, transient only' };
    }
  };
  const classificationStore = {
    async record(messageId, result) {
      events.push(['record-outcome', messageId, result]);
    }
  };
  const processMessage = createGmailClassifierProcessor({ provider, classificationStore });
  const result = await runGmailScanPage({
    provider,
    checkpointStore,
    ledger,
    processMessage,
    nowMs: Date.UTC(2026, 10, 4, 12),
    clock: () => Date.UTC(2026, 10, 4, 12)
  });

  assert.equal(result.fetched, 1);
  assert.equal(result.results[0].status, 'completed');
  const outcomeIndex = events.findIndex(([name]) => name === 'record-outcome');
  const jobCompleteIndex = events.findIndex(([name]) => name === 'complete-job');
  const scanCompleteIndex = events.findIndex(([name]) => name === 'complete-scan');
  assert.ok(outcomeIndex >= 0 && outcomeIndex < jobCompleteIndex);
  assert.ok(jobCompleteIndex < scanCompleteIndex);
  assert.deepEqual(events[outcomeIndex], ['record-outcome', 'mail-id-1', { kind: 'result' }]);
  assert.equal(JSON.stringify(events).includes('winner body'), false);
});

test('Gmail scan does not advance a page when durable classification recording fails', async () => {
  const events = [];
  const checkpointStore = {
    async load() { return null; },
    async saveCursor() { events.push('save-cursor'); },
    async completeScan() { events.push('complete-scan'); }
  };
  const ledger = {
    async claim() { return { claimed: true, status: 'claimed', claimToken: 'lease-1' }; },
    async complete() { events.push('complete-job'); return { status: 'completed', duplicate: false }; },
    async fail() { return { status: 'retry' }; }
  };
  const provider = {
    async listMessages() { return { messages: [{ id: 'mail-id-2' }], nextPageToken: null }; },
    async getMessageForClassification() { return { subject: '抽選結果', text: 'ポケモンカード' }; }
  };
  const processMessage = createGmailClassifierProcessor({
    provider,
    classificationStore: {
      async record() { throw new Error('Firestore unavailable'); }
    }
  });

  await assert.rejects(runGmailScanPage({
    provider,
    checkpointStore,
    ledger,
    processMessage,
    nowMs: Date.UTC(2026, 10, 4, 12)
  }), { name: 'GmailPageIncomplete' });
  assert.deepEqual(events, ['save-cursor']);
});
