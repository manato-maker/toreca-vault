import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailCommandOutbox } from '../src/gmail-command-outbox.js';
import { createFirestoreGmailCommandOutbox } from '../src/firestore-gmail-command-outbox.js';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';
import { createLotteryBusinessEventKey } from '../src/business-event-identity.js';

function fakeFirestore() {
  const documents = new Map();
  return {
    documents,
    doc(path) {
      return { path, async get() { const data = documents.get(path); return { exists: Boolean(data), data: () => structuredClone(data) }; } };
    },
    async runTransaction(callback) {
      const pending = [];
      const tx = {
        async get(ref) { const data = documents.get(ref.path); return { exists: Boolean(data), data: () => structuredClone(data) }; },
        create(ref, value) { pending.push(['create', ref.path, structuredClone(value)]); },
        set(ref, value) { pending.push(['set', ref.path, structuredClone(value)]); }
      };
      const result = await callback(tx);
      for (const [kind, path, value] of pending) {
        if (kind === 'create' && documents.has(path)) throw new Error('already exists');
        documents.set(path, value);
      }
      return result;
    }
  };
}

const draft = { type: 'lottery', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-08', evidenceType: 'chat-report' };
const identity = { retailerKey: 'store-a', applicationId: 'APP-123' };

test('Gmail outbox persists before enqueue and retries the same request after a crash', async () => {
  const db = fakeFirestore();
  const durable = createFirestoreGmailCommandOutbox(db);
  let failMark = true;
  const store = {
    ...durable,
    async markSubmitted(...args) {
      if (failMark) { failMark = false; throw new Error('simulated crash after queue acceptance'); }
      return durable.markSubmitted(...args);
    }
  };
  const submissions = [];
  const queue = { async enqueue(input) {
    submissions.push(structuredClone(input));
    return { status: 'pending', accepted: true, duplicate: submissions.length > 1 };
  } };
  const outbox = createGmailCommandOutbox({ store, commandQueue: queue });
  await assert.rejects(outbox.record({ messageId: 'gmail-private-raw-id', classification: { kind: 'application' }, commandDraft: draft, businessEventIdentity: identity, nowMs: 10 }), /simulated crash/);
  const result = await outbox.retry('gmail-private-raw-id');
  assert.equal(result.status, 'submitted');
  assert.equal(result.duplicate, true);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].requestId, submissions[1].requestId);
  assert.equal(submissions[0].businessEventKey, submissions[1].businessEventKey);
  assert.equal(submissions[0].command.requestId, submissions[0].requestId);
  const stored = [...db.documents.values()][0];
  assert.equal(stored.status, 'submitted');
  assert.equal(JSON.stringify(stored).includes('gmail-private-raw-id'), false);
  assert.equal(JSON.stringify(stored).includes('email body'), false);
});

test('incomplete identity or command fields are routed to review without queueing', async () => {
  const db = fakeFirestore();
  const queueCalls = [];
  const outbox = createGmailCommandOutbox({
    store: createFirestoreGmailCommandOutbox(db),
    commandQueue: { async enqueue(item) { queueCalls.push(item); return { status: 'pending' }; } }
  });
  const result = await outbox.record({ messageId: 'mail-2', classification: { kind: 'result' }, commandDraft: { type: 'lottery-result-exact', title: '商品A', store: '店舗A' }, businessEventIdentity: null, nowMs: 20 });
  assert.equal(result.status, 'review');
  assert.equal(queueCalls.length, 0);
  assert.equal([...db.documents.values()][0].reasonCode, 'command-evidence-incomplete');
});

test('unknown command fields such as email body are rejected before persistence', async () => {
  const db = fakeFirestore();
  const queueCalls = [];
  const outbox = createGmailCommandOutbox({
    store: createFirestoreGmailCommandOutbox(db),
    commandQueue: { async enqueue(item) { queueCalls.push(item); return { status: 'pending' }; } }
  });
  const privateBody = 'private email body must never persist';
  const result = await outbox.record({ messageId: 'mail-private-fields', classification: { kind: 'application' }, commandDraft: { ...draft, body: privateBody }, businessEventIdentity: identity, nowMs: 21 });
  assert.equal(result.status, 'review');
  assert.equal(queueCalls.length, 0);
  const saved = JSON.stringify([...db.documents.values()]);
  assert.equal(saved.includes(privateBody), false);
  assert.equal(saved.includes('body'), false);
});

test('classifier processor writes the durable outbox before returning and never persists mail text', async () => {
  const db = fakeFirestore();
  const outbox = createGmailCommandOutbox({
    store: createFirestoreGmailCommandOutbox(db),
    commandQueue: { async enqueue() { return { status: 'pending', accepted: true, duplicate: false }; } }
  });
  const events = [];
  const processor = createGmailClassifierProcessor({
    provider: { async getMessageForClassification() { return { subject: 'ポケモンカード 抽選申込完了', text: 'email body with confidential text' }; } },
    classificationStore: { async record() { events.push('classification'); } },
    commandOutbox: outbox,
    buildCommandDraft: async () => ({ command: draft, businessEventIdentity: identity })
  });
  const result = await processor({ messageId: 'mail-3' });
  events.push(result.queue.status);
  assert.deepEqual(events, ['classification', 'submitted']);
  const stored = JSON.stringify([...db.documents.values()]);
  assert.equal(stored.includes('email body with confidential text'), false);
  assert.equal(stored.includes('mail-3'), false);
});

test('same explicit identity uses the shared cross-source lottery key and conflicting queue payload goes to review', async () => {
  const db = fakeFirestore();
  let queueInput;
  const outbox = createGmailCommandOutbox({
    store: createFirestoreGmailCommandOutbox(db),
    commandQueue: { async enqueue(input) { queueInput = input; return { status: 'business-event-collision', accepted: false }; } }
  });
  const result = await outbox.record({ messageId: 'mail-4', classification: { kind: 'application' }, commandDraft: draft, businessEventIdentity: identity, nowMs: 40 });
  assert.equal(result.status, 'review');
  assert.match(queueInput.businessEventKey, /^lottery:v1:[a-f0-9]{64}$/);
  assert.equal([...db.documents.values()][0].status, 'review');
});

test('a Gmail retry with a different requestId is suppressed by the Chat business-event key', async () => {
  const db = fakeFirestore();
  const key = createLotteryBusinessEventKey({ kind: 'application', ...identity }).businessEventKey;
  const acceptedByChat = new Map([[key, 'chat-report-123']]);
  const queueCalls = [];
  const queue = { async enqueue(input) {
    queueCalls.push(input);
    const existingRequestId = acceptedByChat.get(input.businessEventKey);
    if (existingRequestId) return { status: 'duplicate', accepted: false, duplicate: true, businessDuplicate: true, existingRequestId };
    acceptedByChat.set(input.businessEventKey, input.requestId);
    return { status: 'pending', accepted: true, duplicate: false };
  } };
  const outbox = createGmailCommandOutbox({ store: createFirestoreGmailCommandOutbox(db), commandQueue: queue });
  const result = await outbox.record({ messageId: 'gmail-distinct-request', classification: { kind: 'application' }, commandDraft: draft, businessEventIdentity: identity, nowMs: 50 });
  assert.equal(result.status, 'submitted');
  assert.equal(result.duplicate, true);
  assert.notEqual(queueCalls[0].requestId, 'chat-report-123');
  assert.equal(queueCalls[0].businessEventKey, key);
  assert.equal(acceptedByChat.size, 1);
});
