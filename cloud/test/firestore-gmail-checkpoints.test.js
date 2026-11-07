import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreGmailCheckpointStore } from '../src/firestore-gmail-checkpoints.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    docs,
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
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = docs.get(ref.path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
        set(ref, value) { writes.push([ref.path, structuredClone(value)]); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

const cursor = {
  sinceMs: 1_800_000_000_000 - 60_000,
  untilMs: 1_800_000_000_000,
  scanType: 'hourly',
  pageToken: null
};

test('Firestore checkpoint store persists only cursor metadata and last success', async () => {
  const db = fakeFirestore();
  const store = createFirestoreGmailCheckpointStore(db, undefined, { clock: () => 1234 });
  await store.saveCursor('hourly', cursor, { expectedCursor: null });
  const saved = await store.load('hourly');
  assert.deepEqual(saved, { cursor, lastSuccessfulAtMs: null });
  const document = db.docs.get('torecaVaultV2/gmailScanCheckpoints/scans/hourly');
  assert.equal(document.updatedAtMs, 1234);
  assert.equal(document.schemaVersion, 1);
  assert.equal(JSON.stringify(document).includes('subject'), false);
});

test('Firestore checkpoint store rejects stale cursor writes and atomically completes a scan', async () => {
  const db = fakeFirestore();
  const store = createFirestoreGmailCheckpointStore(db, undefined, { clock: () => 5678 });
  const next = { ...cursor, pageToken: 'page-2' };
  await store.saveCursor('hourly', cursor, { expectedCursor: null });
  await assert.rejects(
    store.saveCursor('hourly', next, { expectedCursor: null }),
    { name: 'GmailCheckpointConflict' }
  );
  const completed = await store.completeScan('hourly', cursor.untilMs, { expectedCursor: cursor });
  assert.deepEqual(completed, { saved: true, duplicate: false });
  assert.deepEqual(await store.load('hourly'), { cursor: null, lastSuccessfulAtMs: cursor.untilMs });
});

test('Firestore checkpoint store scopes documents by scan type and validates cursors', async () => {
  const store = createFirestoreGmailCheckpointStore(fakeFirestore());
  await assert.rejects(store.load('unexpected'), /scanType must be hourly or results/);
  await assert.rejects(store.saveCursor('results', cursor, { expectedCursor: null }), /does not belong to this scan window/);
});


test('Firestore checkpoint store rejects a stale scan after a newer generation completes', async () => {
  const db = fakeFirestore();
  const store = createFirestoreGmailCheckpointStore(db);
  await store.saveCursor('hourly', cursor, {
    expectedCursor: null,
    expectedLastSuccessfulAtMs: null
  });
  await store.completeScan('hourly', cursor.untilMs, {
    expectedCursor: cursor,
    expectedLastSuccessfulAtMs: null
  });
  await assert.rejects(
    store.saveCursor('hourly', cursor, {
      expectedCursor: null,
      expectedLastSuccessfulAtMs: null
    }),
    { name: 'GmailCheckpointConflict' }
  );
});
