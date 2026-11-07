import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFirestoreGmailCommandOutbox } from '../src/firestore-gmail-command-outbox.js';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';
import { createGmailCommandOutbox } from '../src/gmail-command-outbox.js';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';
import { buildGmailLotteryCommandDraft } from '../src/gmail-lottery-command-builder.js';
import { createServer } from '../src/server.js';

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

test('Chat HTTP intake and Gmail classifier deduplicate one explicit lottery application in Firestore', async (t) => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) return t.skip('FIRESTORE_EMULATOR_HOST is not configured');
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: 'demo-toreca-vault' });
  const suffix = randomUUID().replaceAll('-', '');
  const queueCollection = `torecaVaultV2/crossSourceTest_${suffix}/commands`;
  const outboxCollection = `torecaVaultV2/crossSourceOutbox_${suffix}/messages`;
  const queue = createFirestoreCommandQueue(db, queueCollection);
  const outboxStore = createFirestoreGmailCommandOutbox(db, outboxCollection);
  const apiToken = `synthetic-${randomUUID()}`;
  const server = createServer({
    store: { async read() { return { payload: {}, revision: 1, lastMutationId: '' }; }, async save() { throw new Error('unused'); } },
    commandQueue: queue,
    apiToken,
    commandsEnabled: true
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const queueRef = db.collection(queueCollection);
  const outboxRef = db.collection(outboxCollection);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const ref of [queueRef, outboxRef]) {
      const snapshot = await ref.get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
    await db.terminate();
  });

  const requestId = 'chat-synthetic-request';
  const command = {
    type: 'lottery', title: 'Synthetic product', store: 'カードボックス オーサカ店',
    status: '応募済', applicationDate: '2026-11-08', requestId
  };
  const address = server.address();
  const chatResponse = await fetch(`http://127.0.0.1:${address.port}/api/v2/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId,
      businessEventIdentity: { retailerKey: 'cardbox-osaka', applicationId: 'APP-SYNTHETIC-123' },
      command
    })
  });
  assert.equal(chatResponse.status, 202);
  assert.equal((await chatResponse.json()).accepted, true);

  const commandOutbox = createGmailCommandOutbox({ store: outboxStore, commandQueue: queue });
  const processor = createGmailClassifierProcessor({
    provider: {
      async getMessageForClassification() {
        return {
          subject: '抽選申込完了',
          text: '応募ID: APP-SYNTHETIC-123\n店舗名: カードボックス オーサカ店\n商品名: Synthetic product\n応募日: 2026-11-08'
        };
      }
    },
    classificationStore: { async record() {} },
    commandOutbox,
    buildCommandDraft: ({ fields, classification }) => buildGmailLotteryCommandDraft({
      kind: classification.kind,
      subject: fields.subject,
      text: fields.text,
      retailerAliases: { 'カードボックス オーサカ店': 'cardbox-osaka' }
    })
  });
  const gmailResult = await processor({ messageId: `synthetic-mail-${suffix}` });
  assert.equal(gmailResult.identity.status, 'ready');
  assert.equal(gmailResult.queue.status, 'submitted');
  assert.equal(gmailResult.queue.duplicate, true);

  const collision = await commandOutbox.record({
    messageId: `synthetic-conflicting-mail-${suffix}`,
    classification: { kind: 'application' },
    commandDraft: {
      type: 'lottery', title: 'Conflicting product', store: 'カードボックス オーサカ店',
      status: '応募済', applicationDate: '2026-11-08'
    },
    businessEventIdentity: { retailerKey: 'cardbox-osaka', applicationId: 'APP-SYNTHETIC-123' }
  });
  assert.equal(collision.status, 'review');
  assert.equal(collision.reasonCode, 'queue-conflict');

  const missingIdProcessor = createGmailClassifierProcessor({
    provider: {
      async getMessageForClassification() {
        return { subject: '抽選申込完了', text: '店舗名: カードボックス オーサカ店\n商品名: Synthetic product\n応募日: 2026-11-08' };
      }
    },
    classificationStore: { async record() {} },
    commandOutbox,
    buildCommandDraft: ({ fields, classification }) => buildGmailLotteryCommandDraft({
      kind: classification.kind,
      subject: fields.subject,
      text: fields.text,
      retailerAliases: { 'カードボックス オーサカ店': 'cardbox-osaka' }
    })
  });
  const missingIdResult = await missingIdProcessor({ messageId: `synthetic-missing-id-${suffix}` });
  assert.equal(missingIdResult.identity.status, 'review');
  assert.equal(missingIdResult.queue.status, 'review');

  const queueRows = (await queueRef.get()).docs.map((doc) => doc.data());
  assert.equal(queueRows.filter((row) => row.recordType !== 'business-event-index').length, 1);
  assert.equal(queueRows.filter((row) => row.recordType === 'business-event-index').length, 1);
  assert.equal(queueRows.some((row) => row.requestId === requestId), true);
  assert.equal(queueRows.some((row) => row.requestId?.startsWith('gmail:')), false);
});
