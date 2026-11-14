import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore Emulator persists scheduler heartbeat and counts skipped dispatcher slots', { skip: skipReason }, async () => {
  const [{ Firestore }, { createFirestoreSchedulerHeartbeatStore, evaluateSchedulerHealth }] = await Promise.all([
    import('@google-cloud/firestore'),
    import('../src/scheduler-heartbeat.js')
  ]);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const documentPath = 'schedulerHeartbeatTestRuns/' + randomUUID() + '/dispatchers/current';
  const root = db.doc(documentPath);
  const store = createFirestoreSchedulerHeartbeatStore(db, documentPath, { intervalMs: 15 * 60 * 1000 });

  try {
    assert.equal((await store.recordSuccess({ scheduledAtMs: 900_000, completedAtMs: 901_000 })).latestMissedSlots, 0);
    assert.equal((await store.recordSuccess({ scheduledAtMs: 2_700_000, completedAtMs: 2_701_000, failedJobCount: 1 })).latestMissedSlots, 1);
    const missed = await store.read();
    assert.equal(missed.totalMissedSlots, 1);
    assert.equal(missed.failedJobCount, 1);
    assert.equal(evaluateSchedulerHealth(missed, { nowMs: 2_702_000 }).healthy, false);

    const retry = await store.recordSuccess({ scheduledAtMs: 2_700_000, completedAtMs: 2_703_000, failedJobCount: 0 });
    assert.deepEqual(retry, { recorded: true, duplicate: true, stale: false, refreshed: true });
    const recovered = await store.read();
    assert.equal(recovered.failedJobCount, 0);
    assert.equal(recovered.lastCompletedAtMs, 2_703_000);

    const next = await store.recordSuccess({ scheduledAtMs: 3_600_000, completedAtMs: 3_601_000 });
    assert.equal(next.latestMissedSlots, 0);
    assert.equal(evaluateSchedulerHealth(await store.read(), { nowMs: 3_602_000 }).healthy, true);
  } finally {
    await db.recursiveDelete(root);
    await db.terminate();
  }
});

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

    const nextMutationId = 'emulator-update-' + randomUUID();
    const nextPayload = structuredClone(payload);
    nextPayload.revision = 2;
    nextPayload.lastMutationId = nextMutationId;
    nextPayload.auditLog.push({ mutationId: nextMutationId, transactionId: 'emulator-update', revision: 2 });
    const updated = await store.save({ expectedRevision: 1, mutationId: nextMutationId, payload: nextPayload });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.payload, nextPayload);

    const updatedManifest = (await root.get()).data();
    assert.equal(updatedManifest.revision, 2);
    const updatedChunks = await db.collection(documentPath + '/segments').get();
    assert.equal(updatedChunks.size, updatedManifest.segmentIds.length);
    for (const chunk of updatedChunks.docs) assert.equal(chunk.data().revision, 2);

    const damagedChunk = updatedChunks.docs[0];
    const damagedData = damagedChunk.data();
    damagedData.items[0].memo += '-tampered';
    await damagedChunk.ref.set(damagedData);
    await assert.rejects(store.read(), /snapshot hash does not match/);
  } finally {
    await db.recursiveDelete(root);
    await db.terminate();
  }
});


test('Firestore Emulator initializes a missing staging snapshot atomically and rejects replacement', { skip: skipReason }, async () => {
  const [{ Firestore }, { emptyV2 }, { createFirestoreStore }] = await Promise.all([
    import('@google-cloud/firestore'),
    import('../../v2/core.js'),
    import('../src/firestore-store.js')
  ]);
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const documentPath = 'stagingSnapshotImportTestRuns/' + randomUUID() + '/snapshots/canonical';
  const root = db.doc(documentPath);
  const store = createFirestoreStore(db, documentPath);
  const payload = emptyV2();
  const mutationId = 'import-' + randomUUID();
  payload.revision = 2789;
  payload.lastMutationId = mutationId;
  payload.lotteries = Array.from({ length: 420 }, (_, index) => ({
    id: 'lottery-' + index, title: 'Test event ' + index,
    status: '応募済', memo: 'x'.repeat(1900)
  }));
  payload.auditLog = Array.from({ length: 1800 }, (_, index) => ({
    mutationId: 'prior-' + index, transactionId: 'tx-' + index, revision: index
  }));
  payload.auditLog.push({ mutationId, transactionId: 'snapshot-import', revision: 2789 });

  try {
    const imported = await store.initializeFromSnapshot(payload);
    assert.equal(imported.revision, 2789);
    assert.deepEqual(imported.payload, payload);
    const manifest = (await root.get()).data();
    assert.equal(manifest.storageFormat, 'chunked-v1');
    const chunks = await db.collection(documentPath + '/segments').get();
    assert.equal(chunks.size, manifest.segmentIds.length);
    assert.ok(chunks.size > 1);
    await assert.rejects(store.initializeFromSnapshot(payload), /already initialized/);
    assert.deepEqual((await store.read()).payload, payload);
  } finally {
    await db.recursiveDelete(root);
    await db.terminate();
  }
});
