import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../v2/core.js';
import {
  CanonicalNotInitialized,
  RevisionConflict,
  StateTooLarge,
  createFirestoreStore
} from '../cloud/src/firestore-store.js';

function fakeFirestore(initial) {
  let value = initial ? structuredClone(initial) : null;
  const ref = {
    async get() {
      return { exists: Boolean(value), data: () => structuredClone(value) };
    }
  };
  const db = {
    doc(path) { assert.equal(path, 'torecaVaultV2/canonical'); return ref; },
    async runTransaction(callback) {
      let pending;
      const tx = {
        async get(target) { assert.equal(target, ref); return target.get(); },
        set(target, next) { assert.equal(target, ref); pending = structuredClone(next); }
      };
      const result = await callback(tx);
      if (pending) value = pending;
      return result;
    }
  };
  return db;
}

function purchaseMutation(mutationId) {
  const payload = applyTransaction(emptyV2(), {
    id: `tx-${mutationId}`,
    type: 'purchase',
    product: 'Example BOX',
    productKey: 'example-box',
    category: 'BOX',
    condition: 'あり',
    quantity: 1,
    unitCost: 100,
    date: '2026-11-03'
  }, mutationId);
  return { expectedRevision: 0, mutationId, payload };
}

test('Firestore store refuses to initialize or overwrite a missing canonical state', async () => {
  const store = createFirestoreStore(fakeFirestore());
  assert.equal(await store.read(), null);
  await assert.rejects(store.save(purchaseMutation('m1')), CanonicalNotInitialized);
});

test('Firestore store performs a revision-checked write and returns the verified snapshot', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  const input = purchaseMutation('m1');
  const saved = await store.save(input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.lastMutationId, 'm1');
  assert.equal(saved.payload.transactions.length, 1);
  assert.equal(saved.payload.inventoryLots[0].quantity, 1);
});

test('Firestore store reports replayed mutation IDs as duplicates without another revision', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  const input = purchaseMutation('m1');
  const first = await store.save(input);
  const replay = await store.save(input);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);
  assert.equal(replay.payload.transactions.length, 1);
});

test('Firestore store rejects stale revisions without changing the canonical snapshot', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  await store.save(purchaseMutation('m1'));
  const stale = purchaseMutation('m2');
  stale.payload = applyTransaction(emptyV2(), {
    id: 'tx-m2', type: 'purchase', product: 'Different BOX', productKey: 'different-box',
    category: 'BOX', condition: 'なし', quantity: 1, unitCost: 200, date: '2026-11-03'
  }, 'm2');
  await assert.rejects(store.save(stale), RevisionConflict);
  const current = await store.read();
  assert.equal(current.revision, 1);
  assert.equal(current.payload.transactions.length, 1);
  assert.equal(current.payload.transactions[0].id, 'tx-m1');
});

test('Firestore store fails closed before a snapshot exceeds the document safety limit', async () => {
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() }));
  const input = purchaseMutation('large');
  input.payload.automation.largeDiagnostic = 'x'.repeat(900_001);
  await assert.rejects(store.save(input), StateTooLarge);
  const current = await store.read();
  assert.equal(current.revision, 0);
  assert.equal(current.payload.transactions.length, 0);
});
