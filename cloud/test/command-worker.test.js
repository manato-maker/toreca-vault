import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2 } from '../../v2/core.js';
import { processQueuedCommand } from '../src/command-worker.js';
import { RevisionConflict } from '../src/firestore-store.js';

function memoryQueue(command) {
  let row = { command: structuredClone(command), status: 'pending', attempts: 0, claimToken: '', leaseExpiresAtMs: 0 };
  let nextToken = 0;
  return {
    async claim(_requestId, { now = 0, leaseMs = 100, maxAttempts = 3 } = {}) {
      if (row.status === 'done' || row.status === 'review') return { status: row.status, claimed: false };
      if (row.status === 'processing' && row.leaseExpiresAtMs > now) return { status: 'busy', claimed: false };
      if (row.attempts >= maxAttempts) { row.status = 'review'; return { status: 'exhausted', claimed: false }; }
      row = { ...row, status: 'processing', attempts: row.attempts + 1, claimToken: `lease-${++nextToken}`, leaseExpiresAtMs: now + leaseMs };
      return { status: 'claimed', claimed: true, command: structuredClone(row.command), claimToken: row.claimToken, attempts: row.attempts };
    },
    async finish(_requestId, claimToken, { outcome, resultCode }) {
      if (row.status !== 'processing' || row.claimToken !== claimToken) return { status: 'lease-lost', updated: false };
      row = { ...row, status: outcome, resultCode, claimToken: '', leaseExpiresAtMs: 0 };
      return { status: outcome, updated: true };
    },
    get row() { return structuredClone(row); }
  };
}

function memoryStore(initial = emptyV2()) {
  let current = { payload: structuredClone(initial), revision: Number(initial.revision || 0), lastMutationId: initial.lastMutationId || '' };
  return {
    async read() { return structuredClone(current); },
    async save({ expectedRevision, mutationId, payload }) {
      if (current.payload.auditLog.some((entry) => entry.mutationId === mutationId)) return { ...structuredClone(current), duplicate: true };
      if (current.revision !== expectedRevision) throw new RevisionConflict(current.revision);
      current = { payload: structuredClone(payload), revision: payload.revision, lastMutationId: mutationId };
      return structuredClone(current);
    }
  };
}

const purchase = { type: 'purchase', requestId: 'p-1', product: 'MEGAドリームex', category: 'BOX', condition: 'あり', quantity: 1, unitCost: 34300, date: '2026-11-01', store: '店' };

test('worker applies a command through revision CAS and settles queue only after readback', async () => {
  const queue = memoryQueue(purchase), store = memoryStore();
  let now = 100;
  const result = await processQueuedCommand({ queue, store, requestId: 'p-1', clock: () => now++ });
  assert.equal(result.status, 'done');
  assert.equal(result.resultCode, 'v2-applied');
  assert.equal((await store.read()).revision, 1);
  assert.equal(queue.row.status, 'done');
});

test('ambiguous or unsupported commands go to review without mutating V2', async () => {
  const state = memoryStore();
  const queue = memoryQueue({ ...purchase, type: 'repair-receipt-sale' });
  const result = await processQueuedCommand({ queue, store: state, requestId: 'p-1', clock: () => 100 });
  assert.equal(result.status, 'review');
  assert.equal(result.resultCode, 'command-rejected');
  assert.equal((await state.read()).revision, 0);
});

test('worker rejects a queue row whose request ID differs from the embedded command ID', async () => {
  const queue = memoryQueue(purchase);
  const store = memoryStore();
  const result = await processQueuedCommand({ queue, store, requestId: 'different-id', clock: () => 100 });
  assert.equal(result.status, 'review');
  assert.equal(result.resultCode, 'command-invalid');
  assert.equal((await store.read()).revision, 0);
});

test('revision conflict returns a command to bounded retry without double-application', async () => {
  const queue = memoryQueue(purchase);
  const store = memoryStore();
  store.save = async () => { throw new RevisionConflict(1); };
  const result = await processQueuedCommand({ queue, store, requestId: 'p-1', clock: () => 100 });
  assert.equal(result.status, 'pending');
  assert.equal(result.resultCode, 'revision-conflict');
  assert.equal((await store.read()).revision, 0);
});

test('if state saves before queue settlement, retry sees the mutation ID and does not add the transaction twice', async () => {
  const queue = memoryQueue(purchase);
  const finish = queue.finish.bind(queue);
  let loseFirstSettlement = true;
  queue.finish = async (...args) => {
    if (loseFirstSettlement) { loseFirstSettlement = false; return { status: 'lease-lost', updated: false }; }
    return finish(...args);
  };
  const store = memoryStore();
  let now = 100;
  const first = await processQueuedCommand({ queue, store, requestId: 'p-1', clock: () => now, leaseMs: 10 });
  assert.equal(first.outcome, 'lease-lost');
  now = 111;
  const second = await processQueuedCommand({ queue, store, requestId: 'p-1', clock: () => now, leaseMs: 10 });
  assert.equal(second.status, 'done');
  assert.equal(second.duplicate, true);
  const confirmed = await store.read();
  assert.equal(confirmed.revision, 1);
  assert.equal(confirmed.payload.transactions.length, 1);
});
