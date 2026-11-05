import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore Emulator atomically stores and reads a chunked V2 snapshot', { skip: skipReason }, async () => {
  const [{ Firestore }, { emptyV2 }, { createFirestoreStore }] = await Promise.all([
    import('@google-cloud/firestore'),
    import('../../v2/core.js'),
    import('../src/firestore-store.js')
  ]);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const documentPath = 'snapshotStoreTestRuns/' + randomUUID() + '/snapshots/canonical';
  const root = db.doc(documentPath);
  const store = createFirestoreStore(db, documentPath);
  const initial = emptyV2();
  const mutationId = 'emulator-' + randomUUID();
  const payload = emptyV2();
  payload.revision = 1;
  payload.lastMutationId = mutationId;
  payload.lotteries = Array.from({ length: 420 }, (_, index) => ({
    id: 'lottery-' + index, title: 'Test event ' + index,
    status: '応募済', memo: 'x'.repeat(1900)
  }));
  payload.auditLog = Array.from({ length: 1800 }, (_, index) => ({
    mutationId: 'prior-' + index, transactionId: 'tx-' + index, revision: index
  }));
  payload.auditLog.push({ mutationId, transactionId: 'emulator-seed', revision: 1 });

  try {
    await root.set({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial });
    const saved = await store.save({ expectedRevision: 0, mutationId, payload });
    assert.equal(saved.revision, 1);
    assert.equal(saved.payload.lotteries.length, 420);
    assert.equal(saved.payload.auditLog.length, 1801);

    const manifest = (await root.get()).data();
    assert.equal(manifest.storageFormat, 'chunked-v1');
    const chunks = await db.collection(documentPath + '/segments').get();
    assert.equal(chunks.size, manifest.segmentIds.length);
    assert.ok(chunks.size > 1);
    for (const chunk of chunks.docs) {
      assert.ok(Buffer.byteLength(JSON.stringify(chunk.data()), 'utf8') < 1_048_576);
    }
    const reread = await store.read();
    assert.deepEqual(reread.payload, payload);
  } finally {
    await db.recursiveDelete(root);
    await db.terminate();
  }
});
