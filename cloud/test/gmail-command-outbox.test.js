import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailCommandOutbox } from '../src/gmail-command-outbox.js';
import { createFirestoreGmailCommandOutbox } from '../src/firestore-gmail-command-outbox.js';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';
import { createLotteryBusinessEventKey } from '../src/business-event-identity.js';
import { buildGmailLotteryCommandDraft } from '../src/gmail-lottery-command-builder.js';
import { createServer } from '../src/server.js';

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

test('review resolution requires explicit confirmation and the current review version', async () => {
  const db = fakeFirestore();
  const durable = createFirestoreGmailCommandOutbox(db);
  const queueCalls = [];
  const outbox = createGmailCommandOutbox({
    store: durable,
    commandQueue: { async enqueue(input) { queueCalls.push(input); return { status: 'pending', accepted: true }; } }
  });
  await outbox.record({ messageId: 'mail-review-confirm', classification: { kind: 'application' }, commandDraft: null, businessEventIdentity: null, nowMs: 100 });
  const review = await durable.get([...db.documents.values()][0].messageIdHash);
  const refused = await outbox.approveReview({ messageId: 'mail-review-confirm', expectedPayloadHash: review.payloadHash, confirmed: false, commandDraft: draft, businessEventIdentity: identity, nowMs: 101 });
  assert.equal(refused.reasonCode, 'explicit-confirmation-required');
  assert.equal(queueCalls.length, 0);

  await durable.markReview(review.messageIdHash, 'review-reason-updated');
  const stale = await outbox.approveReview({ messageId: 'mail-review-confirm', expectedPayloadHash: review.payloadHash, confirmed: true, commandDraft: draft, businessEventIdentity: identity, nowMs: 102 });
  assert.equal(stale.status, 'stale');
  assert.equal(queueCalls.length, 0);

  const current = await durable.get(review.messageIdHash);
  const approved = await outbox.approveReview({ messageId: 'mail-review-confirm', expectedPayloadHash: current.payloadHash, confirmed: true, commandDraft: draft, businessEventIdentity: identity, nowMs: 103 });
  assert.equal(approved.status, 'submitted');
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0].requestId, review.requestId);
  assert.equal(queueCalls[0].businessEventKey, createLotteryBusinessEventKey({ kind: 'application', ...identity }).businessEventKey);
  assert.equal((await durable.get(review.messageIdHash)).status, 'submitted');
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

test('conflicting titles and malformed optional dates are routed to review', async () => {
  const db = fakeFirestore();
  const queueCalls = [];
  const outbox = createGmailCommandOutbox({ store: createFirestoreGmailCommandOutbox(db), commandQueue: { async enqueue(input) { queueCalls.push(input); return { status: 'pending' }; } } });
  const result = await outbox.record({
    messageId: 'mail-ambiguous-command', classification: { kind: 'application' },
    commandDraft: { ...draft, product: '別の商品', deadline: '2026-02-31' },
    businessEventIdentity: identity, nowMs: 22
  });
  assert.equal(result.status, 'review');
  assert.equal(queueCalls.length, 0);
});

test('classifier processor writes the durable outbox before returning and never persists mail text', async () => {
  const db = fakeFirestore();
  const outbox = createGmailCommandOutbox({
    store: createFirestoreGmailCommandOutbox(db),
    commandQueue: { async enqueue() { return { status: 'pending', accepted: true, duplicate: false }; } }
  });
  const events = [];
  const processor = createGmailClassifierProcessor({
    provider: { async getMessageForClassification() { return { subject: 'ポケモンカード 抽選申込完了', text: '応募ID: APP-123\n店舗名: トレカショップA\n商品名: 商品A\n応募日: 2026-11-08\nemail body with confidential text' }; } },
    classificationStore: { async record() { events.push('classification'); } },
    commandOutbox: outbox,
    buildCommandDraft: async ({ fields, classification }) => buildGmailLotteryCommandDraft({
      kind: classification.kind,
      subject: fields.subject,
      text: fields.text,
      retailerAliases: { 'トレカショップA': 'shop-a' }
    })
  });
  const result = await processor({ messageId: 'mail-3' });
  events.push(result.queue.status);
  assert.deepEqual(events, ['classification', 'submitted']);
  const stored = JSON.stringify([...db.documents.values()]);
  assert.equal(stored.includes('email body with confidential text'), false);
  assert.equal(stored.includes('mail-3'), false);
  assert.equal([...db.documents.values()][0].command.title, '商品A');
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

test('Chat Action HTTP submission and Gmail classification share one event and queue record', async () => {
  const eventIndex = new Map();
  const requestIndex = new Map();
  const commandQueue = { async enqueue(input) {
    const command = { ...input.command };
    delete command.requestId;
    const businessHash = JSON.stringify(Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))));
    const old = requestIndex.get(input.requestId);
    if (old) return old.businessHash === businessHash && old.key === input.businessEventKey
      ? { status: 'pending', accepted: true, duplicate: true } : { status: 'collision', accepted: false };
    const event = eventIndex.get(input.businessEventKey);
    if (event) return event.businessHash === businessHash
      ? { status: 'duplicate', accepted: false, duplicate: true, businessDuplicate: true, existingRequestId: event.requestId }
      : { status: 'business-event-collision', accepted: false };
    const row = { requestId: input.requestId, key: input.businessEventKey, businessHash };
    eventIndex.set(input.businessEventKey, row);
    requestIndex.set(input.requestId, row);
    return { status: 'pending', accepted: true, duplicate: false };
  } };
  const server = createServer({
    store: { async read() { return { payload: {}, revision: 1, lastMutationId: '' }; }, async save() { throw new Error('unused'); } },
    commandQueue, apiToken: 'test-api-token', commandsEnabled: true
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const chatCommand = { ...draft };
    delete chatCommand.evidenceType;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/commands`, {
      method: 'POST', headers: { authorization: 'Bearer test-api-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'chat-report-123',
        businessEventIdentity: { retailerKey: 'store-a', applicationId: 'APP-123' },
        command: { ...chatCommand, requestId: 'chat-report-123' }
      })
    });
    assert.equal(response.status, 202);
    const chatReceipt = await response.json();
    assert.equal(chatReceipt.accepted, true);

    const db = fakeFirestore();
    const outbox = createGmailCommandOutbox({ store: createFirestoreGmailCommandOutbox(db), commandQueue });
    const processor = createGmailClassifierProcessor({
      provider: { async getMessageForClassification() { return { subject: 'ポケモンカード 抽選申込完了', text: '応募ID: APP-123\n店舗名: 店舗A\n商品名: 商品A\n応募日: 2026-11-08' }; } },
      classificationStore: { async record() {} },
      commandOutbox: outbox,
      buildCommandDraft: ({ fields, classification }) => buildGmailLotteryCommandDraft({
        kind: classification.kind, subject: fields.subject, text: fields.text,
        retailerAliases: { '店舗A': 'store-a' }
      })
    });
    const mailResult = await processor({ messageId: 'distinct-gmail-id' });
    assert.equal(mailResult.queue.status, 'submitted');
    assert.equal(mailResult.queue.duplicate, true);
    assert.equal(eventIndex.size, 1);
    assert.equal(requestIndex.size, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
