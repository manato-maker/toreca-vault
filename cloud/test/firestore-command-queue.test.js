import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';
import { resolveChatLotteryIdentity, resolveGmailLotteryIdentity } from '../src/lottery-event-intake.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    docs,
    doc(path) {
      return { path, async get() {
        const value = docs.get(path);
        return { exists: value !== undefined, data: () => structuredClone(value) };
      } };
    },
    collection(path) {
      return {
        where(field, operation, expected) {
          let results = [...docs.entries()].filter(([documentPath, value]) => {
            const actual = field.split('.').reduce((current, key) => current?.[key], value);
            return documentPath.startsWith(`${path}/`) && (operation === '==' ? actual === expected : operation === 'in' && expected.includes(actual));
          });
          return {
            limit(maximum) {
              return {
                async get() {
                return { docs: results.slice(0, maximum).map(([documentPath, value]) => ({ id: documentPath.slice(path.length + 1), data: () => structuredClone(value) })) };
                }
              };
            }
          };
        }
      };
    },
    async runTransaction(callback) {
      const writes = new Map();
      const transaction = {
        async get(ref) {
          const value = writes.has(ref.path) ? writes.get(ref.path) : docs.get(ref.path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
        create(ref, value) {
          if (docs.has(ref.path)) throw new Error('already exists');
          writes.set(ref.path, structuredClone(value));
        },
        set(ref, value) { writes.set(ref.path, structuredClone(value)); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

function lottery(requestId, product = 'MEGA Dream ex') {
  return { requestId, type: 'lottery', product, retailer: 'store-a', roundId: 'round-2026-11' };
}

test('a shared business event key prevents the same lottery from being queued twice across sources', async () => {
  const db = fakeFirestore();
  const queue = createFirestoreCommandQueue(db);
  const key = 'lottery:store-a:round-2026-11:application';
  assert.deepEqual(await queue.enqueue({ requestId: 'chat-report-1', command: lottery('chat-report-1'), businessEventKey: key, now: 10 }), {
    status: 'pending', accepted: true, duplicate: false
  });
  assert.deepEqual(await queue.enqueue({ requestId: 'gmail-message-2', command: lottery('gmail-message-2'), businessEventKey: key, now: 20 }), {
    status: 'duplicate', accepted: false, duplicate: true, businessDuplicate: true, existingRequestId: 'chat-report-1'
  });
  assert.equal([...db.docs.values()].filter((value) => value.status === 'pending').length, 1);
  assert.equal([...db.docs.values()].some((value) => value.businessEventKey === key), false);
});

test('different Chat and Gmail request IDs deduplicate after deriving the same key from evidence', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  const chatIdentity = resolveChatLotteryIdentity({
    kind: 'application', retailer: 'カードボックス オーサカ店', reportText: '応募番号: CB-991'
  });
  const gmailIdentity = resolveGmailLotteryIdentity({
    kind: 'application', subject: 'カードボックス オーサカ店 抽選申込完了', text: '受付番号: CB-991'
  });
  assert.equal(chatIdentity.status, 'ready');
  assert.deepEqual(gmailIdentity, chatIdentity);

  const chatRequestId = 'chat-report-55';
  const gmailRequestId = 'gmail-message-82';
  const first = await queue.enqueue({
    requestId: chatRequestId,
    command: lottery(chatRequestId),
    businessEventKey: chatIdentity.businessEventKey
  });
  const second = await queue.enqueue({
    requestId: gmailRequestId,
    command: lottery(gmailRequestId),
    businessEventKey: gmailIdentity.businessEventKey
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(second, {
    status: 'duplicate', accepted: false, duplicate: true,
    businessDuplicate: true, existingRequestId: chatRequestId
  });
});

test('reusing a business key for conflicting business data fails closed', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  const key = 'lottery:store-a:round-2026-11:application';
  await queue.enqueue({ requestId: 'chat-report-1', command: lottery('chat-report-1'), businessEventKey: key });
  assert.deepEqual(await queue.enqueue({ requestId: 'gmail-message-2', command: lottery('gmail-message-2', 'Other product'), businessEventKey: key }), {
    status: 'business-event-collision', accepted: false
  });
});

test('business event keys reject empty, oversized, and control-character values', async () => {
  const queue = createFirestoreCommandQueue(fakeFirestore());
  await assert.rejects(queue.enqueue({ requestId: 'r1', command: lottery('r1'), businessEventKey: '  ' }), /businessEventKey/);
  await assert.rejects(queue.enqueue({ requestId: 'r2', command: lottery('r2'), businessEventKey: 'x'.repeat(257) }), /businessEventKey/);
  await assert.rejects(queue.enqueue({ requestId: 'r3', command: lottery('r3'), businessEventKey: 'bad\nkey' }), /businessEventKey/);
});

test('pending queue listing is bounded and excludes business-event index rows', async () => {
  const db = fakeFirestore();
  const queue = createFirestoreCommandQueue(db);
  await queue.enqueue({ requestId: 'r1', command: lottery('r1'), now: 10 });
  await queue.enqueue({ requestId: 'r2', command: lottery('r2'), now: 20 });
  assert.deepEqual(await queue.listPending({ limit: 1 }), [{ requestId: 'r1' }]);
  await assert.rejects(queue.listPending({ limit: 51 }), /limit must be from 1 to 50/);
});

test('intake receipt references are hashed, bounded, and disappear from the pending reconciliation page after verified readback', async () => {
  const db = fakeFirestore();
  const queue = createFirestoreCommandQueue(db);
  const requestId = 'sheet:purchase:42';
  const spreadsheetIdHash = 'a'.repeat(64);
  await queue.enqueue({
    requestId,
    command: { requestId, type: 'purchase', product: 'Sample', quantity: 1, unitPrice: 100 },
    intakeReceipt: { spreadsheetIdHash, rowNumber: 42 },
    now: 123
  });
  const rows = await queue.listIntakeReceipts({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    requestId,
    requestIdHash: '1718000e288369e601ed0ebcc2fc48298a15302a62fb66af667c37e2b8064215',
    spreadsheetIdHash,
    rowNumber: 42,
    receiptState: 'queued'
  });
  const stored = await queue.inspectByRequestIdHash(rows[0].requestIdHash);
  assert.deepEqual(stored.intakeReceipt, { spreadsheetIdHash, rowNumber: 42, state: 'queued', updatedAtMs: 123 });
  assert.equal(JSON.stringify(stored).includes(spreadsheetIdHash), true);
  assert.equal(JSON.stringify(stored).includes('raw-sheet-id-value'), false);
  assert.deepEqual(await queue.setIntakeReceiptStatus(requestId, { state: 'processing', now: 200 }), {
    updated: true, status: 'processing', duplicate: false
  });
  assert.equal((await queue.listIntakeReceipts())[0].receiptState, 'processing');
  assert.deepEqual(await queue.setIntakeReceiptStatus(requestId, { state: 'final', now: 300 }), {
    updated: true, status: 'final', duplicate: false
  });
  assert.deepEqual(await queue.listIntakeReceipts(), []);
  assert.deepEqual(await queue.setIntakeReceiptStatus(requestId, { state: 'processing', now: 400 }), {
    updated: true, status: 'final', duplicate: true
  });
  await assert.rejects(queue.enqueue({
    requestId: 'invalid', command: { requestId: 'invalid', type: 'purchase' },
    intakeReceipt: { spreadsheetIdHash: 'short', rowNumber: 2 }
  }), /intake receipt reference is invalid/);
});
