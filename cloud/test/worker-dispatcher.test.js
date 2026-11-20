import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchJobs } from '../src/worker-dispatcher.js';
import { createFirestoreJobLedger } from '../src/job-ledger.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    doc(path) {
      return {
        path,
        async get() {
          const value = docs.get(path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        }
      };
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

test('dispatches separated handlers and records completion under stable job keys', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const handled = [];
  const options = { ledger, clock: () => 1000, handlers: {
    queue: async (job) => handled.push(job.kind),
    gmail: async (job) => handled.push(job.kind)
  } };
  const jobs = [{ kind: 'queue', jobKey: 'queue:slot' }, { kind: 'gmail', jobKey: 'gmail:slot' }];
  assert.deepEqual((await dispatchJobs(jobs, options)).map((row) => row.status), ['completed', 'completed']);
  assert.deepEqual(handled, ['queue', 'gmail']);
  assert.deepEqual((await dispatchJobs(jobs, options)).map((row) => row.status), ['completed', 'completed']);
  assert.deepEqual(handled, ['queue', 'gmail']);
});

test('continues other jobs after a bounded failure without exposing error messages', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const jobs = [{ kind: 'gmail', jobKey: 'gmail:one' }, { kind: 'queue', jobKey: 'queue:one' }];
  const result = await dispatchJobs(jobs, {
    ledger,
    maxAttempts: 1,
    clock: () => 1234,
    handlers: {
      gmail: async () => { throw Object.assign(new Error('private mail text'), { name: 'GmailQuotaError' }); },
      queue: async () => {}
    }
  });
  assert.deepEqual(result.map((row) => row.status), ['dead', 'completed']);
  assert.equal(result[0].errorCode, 'GmailQuotaError');
  assert.equal(JSON.stringify(result).includes('private mail text'), false);
  assert.equal((await ledger.inspect('gmail:one')).lastErrorCode, 'GmailQuotaError');
});

test('rejects missing or duplicated handlers before claiming work', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const job = { kind: 'queue', jobKey: 'queue:once' };
  await assert.rejects(dispatchJobs([job], { ledger, handlers: {} }), /missing handler/);
  await assert.rejects(dispatchJobs([job, { ...job }], { ledger, handlers: { queue: async () => {} } }), /unique/);
  assert.equal(await ledger.inspect('queue:once'), null);
});

