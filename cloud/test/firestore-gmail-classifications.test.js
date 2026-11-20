import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreGmailClassificationStore } from '../src/firestore-gmail-classifications.js';

function fakeFirestore() {
  const documents = new Map();
  return {
    documents,
    doc(path) {
      return {
        path,
        async get() {
          const value = documents.get(path);
          return { exists: Boolean(value), data: () => structuredClone(value) };
        }
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref.path);
          return { exists: Boolean(value), data: () => structuredClone(value) };
        },
        set(ref, value) { writes.push([ref.path, structuredClone(value)]); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) documents.set(path, value);
      return result;
    }
  };
}

test('classification store writes only the message ID hash and compact outcome once', async () => {
  const db = fakeFirestore();
  const store = createFirestoreGmailClassificationStore(db);
  const first = await store.record('mail-id-1', { kind: 'application' }, { nowMs: 100 });
  const duplicate = await store.record('mail-id-1', { kind: 'application' }, { nowMs: 200 });
  assert.deepEqual(first, { status: 'recorded', outcome: { kind: 'application' } });
  assert.deepEqual(duplicate, { status: 'duplicate', outcome: { kind: 'application' } });
  assert.equal(db.documents.size, 1);
  const [path, value] = [...db.documents.entries()][0];
  assert.match(path, /[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(value).includes('mail-id-1'), false);
  assert.deepEqual(await store.get('mail-id-1'), { kind: 'application', classifiedAtMs: 100 });
});

test('classification store rejects conflicting outcomes and unexpected fields', async () => {
  const store = createFirestoreGmailClassificationStore(fakeFirestore());
  await store.record('mail-id-2', { kind: 'result' }, { nowMs: 100 });
  await assert.rejects(store.record('mail-id-2', { kind: 'application' }), { name: 'GmailClassificationConflict' });
  await assert.rejects(store.record('mail-id-3', { kind: 'ignore', reason: 'unsafe reason' }), /classification is invalid/);
});
