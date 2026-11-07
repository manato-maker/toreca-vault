import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('concurrent cross-source submissions create only one command for a business event', { skip: skipReason }, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const namespace = 'businessEventDedupTestRuns/' + randomUUID();
  const collectionPath = namespace + '/commands';
  const parent = db.doc(namespace);
  try {
    const queue = createFirestoreCommandQueue(db, collectionPath);
    const businessEventKey = 'lottery:store-a:round-1:application';
    const chatRequestId = 'chat-' + randomUUID();
    const gmailRequestId = 'gmail-' + randomUUID();
    const command = (requestId) => ({ requestId, type: 'lottery', product: 'MEGA Dream ex', retailer: 'store-a', roundId: 'round-1' });
    const results = await Promise.all([
      queue.enqueue({ requestId: chatRequestId, command: command(chatRequestId), businessEventKey }),
      queue.enqueue({ requestId: gmailRequestId, command: command(gmailRequestId), businessEventKey })
    ]);
    assert.equal(results.filter((result) => result.accepted).length, 1);
    assert.equal(results.filter((result) => result.businessDuplicate).length, 1);
    const duplicate = results.find((result) => result.businessDuplicate);
    assert.ok(duplicate.existingRequestId);
    const existing = await queue.inspect(duplicate.existingRequestId);
    assert.equal(existing.status, 'pending');
    const commandDocs = await db.collection(collectionPath).where('status', '==', 'pending').count().get();
    assert.equal(commandDocs.data().count, 1);
  } finally {
    await db.recursiveDelete(parent);
    await db.terminate();
  }
});
