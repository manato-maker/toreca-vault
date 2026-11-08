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

test('pending queue pages return only pending command request IDs', { skip: skipReason }, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const namespace = 'commandPendingPageTestRuns/' + randomUUID();
  const collectionPath = namespace + '/commands';
  const parent = db.doc(namespace);
  try {
    const queue = createFirestoreCommandQueue(db, collectionPath);
    for (const requestId of ['pending-a', 'pending-b']) {
      await queue.enqueue({ requestId, command: { requestId, type: 'purchase', title: 'Product', quantity: 1, unitPrice: 1000, purchaseDate: '2026-11-08' } });
    }
    const page = await queue.listPending({ limit: 2 });
    assert.deepEqual(page.map((entry) => entry.requestId).sort(), ['pending-a', 'pending-b']);
  } finally {
    await db.recursiveDelete(parent);
    await db.terminate();
  }
});

test('Firestore intake receipt correlation survives until the final sheet readback is confirmed', { skip: skipReason }, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const namespace = 'sheetsIntakeReceiptTestRuns/' + randomUUID();
  const collectionPath = namespace + '/commands';
  const parent = db.doc(namespace);
  try {
    const queue = createFirestoreCommandQueue(db, collectionPath);
    const requestId = 'sheet-' + randomUUID();
    const intakeReceipt = { spreadsheetIdHash: 'a'.repeat(64), rowNumber: 23 };
    await queue.enqueue({ requestId, command: { requestId, type: 'purchase' }, intakeReceipt, now: 100 });
    const page = await queue.listIntakeReceipts({ limit: 10 });
    assert.equal(page.length, 1);
    assert.equal(page[0].requestId, requestId);
    assert.equal(page[0].rowNumber, 23);
    assert.equal(page[0].receiptState, 'queued');
    assert.equal((await queue.inspectByRequestIdHash(page[0].requestIdHash)).intakeReceipt.spreadsheetIdHash, intakeReceipt.spreadsheetIdHash);
    assert.deepEqual(await queue.setIntakeReceiptStatus(requestId, { state: 'processing', now: 200 }), { updated: true, status: 'processing', duplicate: false });
    assert.equal((await queue.listIntakeReceipts({ limit: 10 }))[0].receiptState, 'processing');
    assert.deepEqual(await queue.setIntakeReceiptStatus(requestId, { state: 'final', now: 300 }), { updated: true, status: 'final', duplicate: false });
    assert.deepEqual(await queue.listIntakeReceipts({ limit: 10 }), []);
  } finally {
    await db.recursiveDelete(parent);
    await db.terminate();
  }
});
