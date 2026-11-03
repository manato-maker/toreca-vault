import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

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
        create(ref, value) {
          if (docs.has(ref.path)) throw new Error('already exists');
          writes.set(ref.path, structuredClone(value));
        },
        set(ref, value) { writes.set(ref.path, structuredClone(value)); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

const sale = (requestId, amount = 55300) => ({ requestId, type: 'sale', date: '2026-11-01', amount });

test('enqueues once and recognizes exact resends independent of object key order', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  assert.deepEqual(await queue.enqueue({ requestId: 'sale-1', command: sale('sale-1'), now: 100 }), {
    status: 'pending', accepted: true, duplicate: false
  });
  assert.deepEqual(await queue.enqueue({ requestId: 'sale-1', command: { amount: 55300, date: '2026-11-01', type: 'sale', requestId: 'sale-1' }, now: 200 }), {
    status: 'pending', accepted: true, duplicate: true
  });
});

test('rejects request ID collisions and mismatched or unsupported commands', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  await queue.enqueue({ requestId: 'sale-1', command: sale('sale-1') });
  assert.deepEqual(await queue.enqueue({ requestId: 'sale-1', command: sale('sale-1', 100) }), {
    status: 'collision', accepted: false
  });
  await assert.rejects(queue.enqueue({ requestId: 'sale-2', command: sale('other') }), /does not match/);
  await assert.rejects(queue.enqueue({ requestId: 'x', command: { requestId: 'x', type: 'email-send' } }), /unsupported/);
});

test('leases fence stale workers and completed commands cannot be claimed again', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  await queue.enqueue({ requestId: 'sale-1', command: sale('sale-1'), now: 10 });
  const first = await queue.claim('sale-1', { now: 20, leaseMs: 10 });
  assert.equal(first.status, 'claimed');
  assert.equal((await queue.claim('sale-1', { now: 25, leaseMs: 10 })).status, 'busy');
  const second = await queue.claim('sale-1', { now: 31, leaseMs: 10 });
  assert.equal(second.status, 'claimed');
  assert.deepEqual(await queue.finish('sale-1', first.claimToken, { outcome: 'done', now: 32 }), { status: 'lease-lost', updated: false });
  assert.deepEqual(await queue.finish('sale-1', second.claimToken, { outcome: 'done', resultCode: 'sale-applied', now: 33 }), { status: 'done', updated: true });
  assert.equal((await queue.claim('sale-1', { now: 40 })).status, 'done');
  assert.equal((await queue.inspect('sale-1')).command.amount, 55300);
});

test('validates bounded lease and payload settings', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  await queue.enqueue({ requestId: 'sale-1', command: sale('sale-1') });
  await assert.rejects(queue.claim('sale-1', { leaseMs: 0 }), /leaseMs/);
  await assert.rejects(queue.claim('sale-1', { maxAttempts: 0 }), /maxAttempts/);
  await assert.rejects(queue.enqueue({ requestId: 'large', command: { requestId: 'large', type: 'sale', memo: 'x'.repeat(20001) } }), /20000-byte/);
});
