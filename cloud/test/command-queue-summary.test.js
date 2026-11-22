import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

function fakeDb(statuses, invalidCount = false) {
  const calls = [];
  return {
    calls,
    doc(path) { return { path }; },
    async runTransaction() { throw new Error('not used in summary test'); },
    collection(path) {
      return {
        where(field, operation, value) {
          calls.push({ path, field, operation, value });
          const matches = statuses.filter(status => operation === 'in' ? value.includes(status) : status === value);
          return {
            count() {
              return { async get() { return { data: () => ({ count: invalidCount ? -1 : matches.length }) }; } };
            }
          };
        }
      };
    }
  };
}

test('command queue summary uses two aggregate counts and returns only bounded status totals', async () => {
  const db = fakeDb(['pending', 'processing', 'review', 'done', 'done']);
  const queue = createFirestoreCommandQueue(db, 'test/queue/commands');
  assert.deepEqual(await queue.summarize(), { unprocessedCount: 2, reviewCount: 1 });
  assert.deepEqual(db.calls, [
    { path: 'test/queue/commands', field: 'status', operation: 'in', value: ['pending', 'processing'] },
    { path: 'test/queue/commands', field: 'status', operation: '==', value: 'review' }
  ]);
});

test('command queue summary fails closed when Firestore returns an invalid aggregate', async () => {
  const queue = createFirestoreCommandQueue(fakeDb(['pending'], true));
  await assert.rejects(queue.summarize(), /invalid queue summary/);
});
