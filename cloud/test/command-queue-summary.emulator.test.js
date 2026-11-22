import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore Emulator aggregates pending, processing, and review command counts', { skip: skipReason }, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const namespace = 'queueSummaryTestRuns/' + randomUUID();
  const collectionPath = namespace + '/commands';
  const parent = db.doc(namespace);
  try {
    await Promise.all([
      db.doc(collectionPath + '/pending').set({ status: 'pending' }),
      db.doc(collectionPath + '/processing').set({ status: 'processing' }),
      db.doc(collectionPath + '/review').set({ status: 'review' }),
      db.doc(collectionPath + '/done').set({ status: 'done' })
    ]);
    const queue = createFirestoreCommandQueue(db, collectionPath);
    assert.deepEqual(await queue.summarize(), { unprocessedCount: 2, reviewCount: 1 });
  } finally {
    await db.recursiveDelete(parent);
    await db.terminate();
  }
});
