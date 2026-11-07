import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFirestoreGmailCommandOutbox } from '../src/firestore-gmail-command-outbox.js';

test('Firestore Gmail outbox creates once under concurrent retries and stores no raw message ID', async (t) => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) return t.skip('FIRESTORE_EMULATOR_HOST is not configured');
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: 'demo-toreca-vault' });
  const collectionPath = `torecaVaultV2/gmailOutboxTest_${randomUUID().replaceAll('-', '')}/messages`;
  const store = createFirestoreGmailCommandOutbox(db, collectionPath);
  const messageId = `synthetic-mail-${randomUUID()}`;
  const messageIdHash = createHash('sha256').update(messageId).digest('hex');
  const entry = {
    messageIdHash,
    requestId: `gmail:${messageIdHash.slice(0, 32)}`,
    kind: 'application',
    status: 'ready',
    command: { type: 'lottery', title: 'Synthetic product', store: 'Synthetic store', status: '応募済', applicationDate: '2026-11-08', requestId: `gmail:${messageIdHash.slice(0, 32)}` },
    businessEventKey: `lottery:v1:${'a'.repeat(64)}`,
    createdAtMs: Date.now()
  };
  const ref = db.doc(`${collectionPath}/${messageIdHash}`);
  t.after(async () => {
    await ref.delete().catch(() => {});
    await db.terminate();
  });

  const results = await Promise.all([store.recordOnce(entry), store.recordOnce(entry)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['duplicate', 'recorded']);
  const readback = await store.get(messageIdHash);
  assert.equal(readback.status, 'ready');
  assert.equal(readback.payloadHash.length, 64);
  assert.equal(JSON.stringify(readback).includes(messageId), false);
  assert.equal((await store.markSubmitted(messageIdHash, 'queued')).status, 'submitted');
  assert.equal((await store.get(messageIdHash)).status, 'submitted');
});
