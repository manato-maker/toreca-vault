import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import { createBackupArtifact, verifyBackupArtifact } from '../src/backup-artifact.js';
import { createFirestoreStore } from '../src/firestore-store.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore Emulator restores a verified backup into an isolated canonical store and reads it back', { skip: skipReason }, async () => {
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const documentPath = 'backupRestoreTestRuns/' + randomUUID() + '/canonical';
  const root = db.doc(documentPath);
  const store = createFirestoreStore(db, documentPath);
  const mutationId = 'backup-restore-' + randomUUID();
  let payload = applyTransaction(emptyV2(), {
    id: 'restore-seed-purchase', type: 'purchase', product: 'Emulator fixture',
    productKey: 'emulator-fixture', category: 'BOX', condition: 'あり',
    quantity: 2, unitCost: 1250, date: '2026-11-07'
  }, mutationId);
  payload.lotteries = Array.from({ length: 520 }, (_, index) => ({
    id: 'lottery-' + index, title: 'Synthetic event ' + index,
    status: '応募済', memo: 'fixture '.repeat(250)
  }));
  payload.auditLog = Array.from({ length: 1800 }, (_, index) => ({
    mutationId: 'prior-' + index, transactionId: 'tx-' + index, revision: index
  }));
  payload.auditLog.push({ mutationId, transactionId: 'restore-seed-purchase', revision: 1 });
  const backup = createBackupArtifact(payload, { createdAt: '2026-11-07T12:30:00.000Z' });
  const before = verifyBackupArtifact(backup);

  try {
    await root.set({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() });
    const saved = await store.save({ expectedRevision: 0, mutationId, payload: backup.payload });
    assert.equal(saved.revision, 1);
    assert.equal((await root.get()).data().storageFormat, 'chunked-v1');
    const restored = await store.read();
    assert.deepEqual(restored.payload, backup.payload);
    assert.equal(verifyBackupArtifact(createBackupArtifact(restored.payload, { createdAt: backup.createdAt })).payloadHash, before.payloadHash);
    assert.equal(restored.revision, before.revision);
  } finally {
    await db.recursiveDelete(root);
    await db.terminate();
  }
});
