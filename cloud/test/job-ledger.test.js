import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreJobLedger } from '../src/job-ledger.js';

function fakeFirestore() {
  const docs = new Map();
  const db = {
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
  return db;
}

test('claims a job once, then marks its stable key completed', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const claim = await ledger.claim('gmail:2026-11-03T09:00+09:00', { now: 1000, leaseMs: 100, maxAttempts: 3 });
  assert.equal(claim.status, 'claimed');
  assert.equal(claim.attempts, 1);
  const duplicate = await ledger.claim('gmail:2026-11-03T09:00+09:00', { now: 1050, leaseMs: 100, maxAttempts: 3 });
  assert.deepEqual(duplicate, { status: 'busy', claimed: false });
  assert.deepEqual(await ledger.complete('gmail:2026-11-03T09:00+09:00', claim.claimToken, { now: 1060 }), {
    status: 'completed', duplicate: false
  });
  assert.deepEqual(await ledger.claim('gmail:2026-11-03T09:00+09:00', { now: 1070 }), {
    status: 'completed', claimed: false
  });
});

test('expired leases can be reclaimed and fence off a late worker', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const first = await ledger.claim('queue:slot-1', { now: 0, leaseMs: 100, maxAttempts: 3 });
  const second = await ledger.claim('queue:slot-1', { now: 101, leaseMs: 100, maxAttempts: 3 });
  assert.equal(second.status, 'claimed');
  assert.notEqual(second.claimToken, first.claimToken);
  await assert.rejects(ledger.complete('queue:slot-1', first.claimToken, { now: 102 }), /lost or superseded/);
  assert.equal((await ledger.complete('queue:slot-1', second.claimToken, { now: 103 })).duplicate, false);
});

test('retries failures up to a bounded attempt count and stores only a safe error code', async () => {
  const ledger = createFirestoreJobLedger(fakeFirestore());
  const first = await ledger.claim('market:2026-11-03', { now: 1, maxAttempts: 2 });
  assert.equal((await ledger.fail('market:2026-11-03', first.claimToken, new Error('private response body'), { now: 2, maxAttempts: 2 })).status, 'retry');
  const second = await ledger.claim('market:2026-11-03', { now: 3, maxAttempts: 2 });
  assert.equal((await ledger.fail('market:2026-11-03', second.claimToken, Object.assign(new Error('secret'), { name: 'NetworkError' }), { now: 4, maxAttempts: 2 })).status, 'dead');
  const saved = await ledger.inspect('market:2026-11-03');
  assert.equal(saved.status, 'dead');
  assert.equal(saved.lastErrorCode, 'NetworkError');
  assert.equal(JSON.stringify(saved).includes('private response body'), false);
  assert.equal((await ledger.claim('market:2026-11-03', { now: 5, maxAttempts: 2 })).status, 'exhausted');
});

test('uses hashed document IDs and rejects malformed leases', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  await assert.rejects(ledger.claim(''), /jobKey/);
  await assert.rejects(ledger.claim('ok', { now: 1, leaseMs: 0 }), /leaseMs/);
  await assert.rejects(ledger.claim('ok', { now: 1, maxAttempts: 0 }), /maxAttempts/);
  const claim = await ledger.claim('job/with/path', { now: 1 });
  assert.ok(claim.claimToken);
  const row = await ledger.inspect('job/with/path');
  assert.ok(row.expireAt instanceof Date);
  assert.ok(row.status === 'running');
});

