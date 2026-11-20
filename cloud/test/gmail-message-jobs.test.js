import test from 'node:test';
import assert from 'node:assert/strict';
import { planGmailMessageJobs } from '../src/gmail-message-jobs.js';
import { createFirestoreJobLedger } from '../src/job-ledger.js';
import { dispatchJobs } from '../src/worker-dispatcher.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    doc(path) {
      return { path, async get() {
        const value = docs.get(path);
        return { exists: value !== undefined, data: () => structuredClone(value) };
      } };
    },
    async runTransaction(callback) {
      const writes = new Map();
      const transaction = {
        async get(ref) {
          const value = writes.has(ref.path) ? writes.get(ref.path) : docs.get(ref.path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
        set(ref, value) { writes.set(ref.path, structuredClone(value)); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

test('message jobs use stable hashed IDs and deduplicate repeated IDs within a page', () => {
  const jobs = planGmailMessageJobs([{ id: 'm-1', subject: 'private' }, { id: 'm-1', body: 'secret' }, { id: 'm-2' }]);
  assert.equal(jobs.length, 2);
  assert.match(jobs[0].jobKey, /^gmail-message:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(jobs).includes('private'), false);
  assert.equal(JSON.stringify(jobs).includes('secret'), false);
  assert.notEqual(jobs[0].jobKey, jobs[1].jobKey);
});

test('message job keys let the durable ledger skip a message already processed on a prior scan', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  let processed = 0;
  const handler = { 'gmail-message': async (job) => { assert.ok(job.messageId); processed++; } };
  const firstScan = planGmailMessageJobs([{ id: 'provider-message-1' }]);
  const secondScan = planGmailMessageJobs([{ id: 'provider-message-1' }]);
  await dispatchJobs(firstScan, { ledger, handlers: handler, clock: () => 100 });
  const results = await dispatchJobs(secondScan, { ledger, handlers: handler, clock: () => 200 });
  assert.equal(processed, 1);
  assert.equal(results[0].status, 'completed');
});

test('message planning rejects invalid IDs and oversized provider pages instead of dropping work', () => {
  assert.throws(() => planGmailMessageJobs([{ id: '' }]), /provider message ID/);
  assert.throws(() => planGmailMessageJobs([{ id: 'one' }, { id: 'two' }], { maxMessages: 1 }), /exceeds/);
  assert.throws(() => planGmailMessageJobs([], { maxMessages: 101 }), /maxMessages/);
});
