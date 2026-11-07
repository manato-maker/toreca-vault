import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    docs,
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

function lottery(requestId, product = 'MEGA Dream ex') {
  return { requestId, type: 'lottery', product, retailer: 'store-a', roundId: 'round-2026-11' };
}

test('a shared business event key prevents the same lottery from being queued twice across sources', async () => {
  const db = fakeFirestore();
  const queue = createFirestoreCommandQueue(db);
  const key = 'lottery:store-a:round-2026-11:application';
  assert.deepEqual(await queue.enqueue({ requestId: 'chat-report-1', command: lottery('chat-report-1'), businessEventKey: key, now: 10 }), {
    status: 'pending', accepted: true, duplicate: false
  });
  assert.deepEqual(await queue.enqueue({ requestId: 'gmail-message-2', command: lottery('gmail-message-2'), businessEventKey: key, now: 20 }), {
    status: 'duplicate', accepted: false, duplicate: true, businessDuplicate: true, existingRequestId: 'chat-report-1'
  });
  assert.equal([...db.docs.values()].filter((value) => value.status === 'pending').length, 1);
  assert.equal([...db.docs.values()].some((value) => value.businessEventKey === key), false);
});

test('reusing a business key for conflicting business data fails closed', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  const key = 'lottery:store-a:round-2026-11:application';
  await queue.enqueue({ requestId: 'chat-report-1', command: lottery('chat-report-1'), businessEventKey: key });
  assert.deepEqual(await queue.enqueue({ requestId: 'gmail-message-2', command: lottery('gmail-message-2', 'Other product'), businessEventKey: key }), {
    status: 'business-event-collision', accepted: false
  });
});

test('business event keys reject empty, oversized, and control-character values', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  await assert.rejects(queue.enqueue({ requestId: 'r1', command: lottery('r1'), businessEventKey: '  ' }), /businessEventKey/);
  await assert.rejects(queue.enqueue({ requestId: 'r2', command: lottery('r2'), businessEventKey: 'x'.repeat(257) }), /businessEventKey/);
  await assert.rejects(queue.enqueue({ requestId: 'r3', command: lottery('r3'), businessEventKey: 'bad\nkey' }), /businessEventKey/);
});
