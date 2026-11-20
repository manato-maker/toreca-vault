import test from 'node:test';
import assert from 'node:assert/strict';
import { createLotteryBusinessEventKey } from '../src/business-event-identity.js';
import { resolveLotteryIdentityFromGmail } from '../src/lottery-source-identity.js';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';

const aliases = { 'ストアＡ': 'store-a', 'Store A': 'store-a', 'store b': 'store-b' };
const gmail = (overrides = {}) => ({
  kind: 'application',
  subject: 'ポケモンカード 抽選申込完了',
  text: '店舗名：Ｓｔｏｒｅ　Ａ\nお申込み番号：ＡＢ－１２３',
  retailerAliases: aliases,
  ...overrides
});

test('confirmed Gmail application identity produces the same event key as a Chat screenshot', () => {
  const fromGmail = resolveLotteryIdentityFromGmail(gmail());
  const fromChat = createLotteryBusinessEventKey({ kind: 'application', retailerKey: 'store-a', applicationId: 'AB-123' });
  assert.deepEqual(fromGmail, fromChat);
  assert.match(fromGmail.businessEventKey, /^lottery:v1:[a-f0-9]{64}$/);
});

test('repeated identical labels do not cause false identity conflicts', () => {
  const sameId = resolveLotteryIdentityFromGmail(gmail({
    text: '店舗名: Store A\n申込番号: AB-123\n応募ID: AB-123\n応募店舗: ストアA'
  }));
  assert.equal(sameId.status, 'ready');
});

test('result and application have distinct event keys for the same external entry', () => {
  const a = resolveLotteryIdentityFromGmail(gmail());
  const b = resolveLotteryIdentityFromGmail(gmail({ kind: 'result' }));
  assert.notEqual(a.businessEventKey, b.businessEventKey);
});

test('missing explicit ID, unknown store or unlabelled values never create a key', () => {
  for (const changed of [
    { text: '店舗名: Store A\n当選番号: AB-123' },
    { text: '店舗名: Store X\n応募番号: AB-123' },
    { text: 'Store A AB-123' },
    { text: '店舗名: Store A\nAB-123' }
  ]) {
    const result = resolveLotteryIdentityFromGmail(gmail(changed));
    assert.equal(result.status, 'review');
    assert.equal('businessEventKey' in result, false);
  }
});

test('conflicting application IDs or retailer labels are review-only', () => {
  for (const text of [
    '店舗名: Store A\n応募番号: AB-123\n応募ID: CD-456',
    '店舗名: Store A\n店舗名: Store B\n応募番号: AB-123',
    '店舗名: Store A\n店舗名: Unlisted\n応募番号: AB-123'
  ]) {
    assert.deepEqual(resolveLotteryIdentityFromGmail(gmail({ text })), {
      status: 'review', reasonCode: 'lottery-identity-conflict'
    });
  }
});

test('invalid or oversized input stays in review, not a guessed identifier', () => {
  assert.deepEqual(resolveLotteryIdentityFromGmail(gmail({ text: 'x'.repeat(512 * 1024 + 1) })), {
    status: 'review', reasonCode: 'lottery-identity-invalid'
  });
  assert.throws(() => resolveLotteryIdentityFromGmail(gmail({ retailerAliases: [] })), /configuration/);
  assert.throws(() => resolveLotteryIdentityFromGmail(gmail({ retailerAliases: { 'Store A': 'one', 'Ｓｔｏｒｅ Ａ': 'two' } })), /conflicts/);
});

test('return values contain no raw application ID or Gmail body', () => {
  const output = JSON.stringify(resolveLotteryIdentityFromGmail(gmail()));
  assert.equal(output.includes('AB-123'), false);
  assert.equal(output.includes('ポケモンカード'), false);
});

function fakeFirestore() {
  const docs = new Map();
  return {
    docs,
    doc(path) { return { path }; },
    async runTransaction(callback) {
      const writes = new Map();
      const tx = {
        async get(ref) {
          const item = docs.get(ref.path);
          return { exists: item !== undefined, data: () => structuredClone(item) };
        },
        create(ref, item) {
          if (docs.has(ref.path) || writes.has(ref.path)) throw new Error('already exists');
          writes.set(ref.path, structuredClone(item));
        },
        set(ref, item) { writes.set(ref.path, structuredClone(item)); }
      };
      const outcome = await callback(tx);
      for (const [key, item] of writes) docs.set(key, item);
      return outcome;
    }
  };
}
function lotteryCommand(requestId, title = 'Synthetic Card Set') {
  return { requestId, type: 'lottery', title, store: 'store-a', applicationDate: '2026-11-07' };
}

test('Gmail and Chat derived keys allow one queued lottery across distinct request IDs', async () => {
  const db = fakeFirestore();
  const queue = createFirestoreCommandQueue(db);
  const chatKey = createLotteryBusinessEventKey({ kind: 'application', retailerKey: 'store-a', applicationId: 'AB-123' });
  const gmailKey = resolveLotteryIdentityFromGmail(gmail());
  assert.equal(chatKey.businessEventKey, gmailKey.businessEventKey);
  assert.deepEqual(await queue.enqueue({
    requestId: 'chat-1', command: lotteryCommand('chat-1'), businessEventKey: chatKey.businessEventKey, now: 1
  }), { status: 'pending', accepted: true, duplicate: false });
  assert.deepEqual(await queue.enqueue({
    requestId: 'gmail-2', command: lotteryCommand('gmail-2'), businessEventKey: gmailKey.businessEventKey, now: 2
  }), {
    status: 'duplicate', accepted: false, duplicate: true,
    businessDuplicate: true, existingRequestId: 'chat-1'
  });
  assert.equal([...db.docs.values()].filter((row) => row.status === 'pending').length, 1);
});

test('same external ID with conflicting business payload stops rather than silently merging', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  const key = resolveLotteryIdentityFromGmail(gmail()).businessEventKey;
  await queue.enqueue({ requestId: 'chat-1', command: lotteryCommand('chat-1'), businessEventKey: key });
  const conflict = await queue.enqueue({
    requestId: 'gmail-2', command: lotteryCommand('gmail-2', 'Different Set'), businessEventKey: key
  });
  assert.deepEqual(conflict, { status: 'business-event-collision', accepted: false });
});
