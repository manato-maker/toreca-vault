import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../v2/core.js';
import {
  CanonicalNotInitialized, RevisionConflict, StateTooLarge, createFirestoreStore
} from '../cloud/src/firestore-store.js';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function fakeFirestore(initial) {
  const docs = new Map();
  if (initial !== undefined) docs.set('torecaVaultV2/canonical', clone(initial));
  return {
    doc(path) {
      return {
        path,
        async get() {
          const value = docs.get(path);
          return { exists: value !== undefined, data: () => clone(value) };
        }
      };
    },
    async runTransaction(callback) {
      const writes = new Map();
      const deletes = new Set();
      const transaction = {
        async get(ref) {
          const value = writes.has(ref.path) ? writes.get(ref.path) : docs.get(ref.path);
          return { exists: value !== undefined && !deletes.has(ref.path), data: () => clone(value) };
        },
        set(ref, value) { writes.set(ref.path, clone(value)); deletes.delete(ref.path); },
        create(ref, value) {
          const exists = writes.has(ref.path) || (docs.has(ref.path) && !deletes.has(ref.path));
          if (exists) throw new Error('document already exists');
          writes.set(ref.path, clone(value)); deletes.delete(ref.path);
        },
        delete(ref) { writes.delete(ref.path); deletes.add(ref.path); }
      };
      const result = await callback(transaction);
      for (const path of deletes) docs.delete(path);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    },
    remove(path) { docs.delete(path); },
    mutate(path, mutator) { docs.set(path, mutator(clone(docs.get(path)))); },
    dump() { return new Map([...docs].map(([path, value]) => [path, clone(value)])); }
  };
}

function purchaseMutation(mutationId, expectedRevision = 0) {
  const base = expectedRevision === 0 ? emptyV2() : null;
  if (!base) throw new Error('test helper only supports initial purchase mutation');
  const payload = applyTransaction(base, {
    id: 'tx-' + mutationId, type: 'purchase', product: 'Example BOX',
    productKey: 'example-box', category: 'BOX', condition: 'あり',
    quantity: 1, unitCost: 100, date: '2026-11-03'
  }, mutationId);
  return { expectedRevision, mutationId, payload };
}

function largeMutation(mutationId, expectedRevision = 0) {
  const payload = emptyV2();
  payload.revision = expectedRevision + 1;
  payload.lastMutationId = mutationId;
  payload.lotteries = Array.from({ length: 520 }, (_, index) => ({
    id: 'lottery-' + index, title: 'Test event ' + index, status: '応募済',
    memo: 'x'.repeat(1900)
  }));
  payload.auditLog = Array.from({ length: 2600 }, (_, index) => ({
    mutationId: 'prior-' + index, transactionId: 'tx-' + index, revision: index
  }));
  payload.auditLog.push({ mutationId, transactionId: 'seed', revision: expectedRevision + 1 });
  return { expectedRevision, mutationId, payload };
}

test('Firestore store refuses to initialize a missing canonical state', async () => {
  const store = createFirestoreStore(fakeFirestore());
  assert.equal(await store.read(), null);
  await assert.rejects(store.save(purchaseMutation('m1')), CanonicalNotInitialized);
});

test('Firestore store initializes a validated snapshot only when canonical state is absent', async () => {
  const payload = emptyV2();
  payload.revision = 2789;
  payload.lastMutationId = 'export-mutation-2789';
  const db = fakeFirestore();
  const store = createFirestoreStore(db);
  const initialized = await store.initializeFromSnapshot(payload);
  assert.equal(initialized.revision, 2789);
  assert.deepEqual(initialized.payload, payload);
  assert.equal(initialized.duplicate, false);
  await assert.rejects(store.initializeFromSnapshot(payload), /already initialized/);
  assert.equal((await store.read()).revision, 2789);
});

test('Firestore store initializes and reads back a large chunked snapshot', async () => {
  const db = fakeFirestore();
  const store = createFirestoreStore(db);
  const payload = largeMutation('staging-import').payload;
  const initialized = await store.initializeFromSnapshot(payload);
  assert.equal(initialized.revision, 1);
  assert.deepEqual(initialized.payload, payload);
  assert.equal(db.dump().get('torecaVaultV2/canonical').storageFormat, 'chunked-v1');
});

test('Firestore store writes legacy-sized snapshots and verifies readback', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  const saved = await store.save(purchaseMutation('m1'));
  assert.equal(saved.revision, 1);
  assert.equal(saved.lastMutationId, 'm1');
  assert.equal(saved.payload.transactions.length, 1);
  assert.equal(saved.payload.inventoryLots[0].quantity, 1);
  const stored = [...(await store.read()).payload.transactions];
  assert.equal(stored[0].id, 'tx-m1');
});

test('Firestore store recognizes old mutation IDs without creating a new revision', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  const input = purchaseMutation('m1');
  const first = await store.save(input);
  const replay = await store.save(input);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);
});

test('Firestore store rejects stale revisions without changing the canonical snapshot', async () => {
  const initial = emptyV2();
  const store = createFirestoreStore(fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial }));
  await store.save(purchaseMutation('m1'));
  const stale = { ...purchaseMutation('m2'), expectedRevision: 0 };
  await assert.rejects(store.save(stale), RevisionConflict);
  const current = await store.read();
  assert.equal(current.revision, 1);
  assert.equal(current.payload.transactions[0].id, 'tx-m1');
});

test('Firestore store chunks large snapshots and preserves transactional readback', async () => {
  const initial = emptyV2();
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial });
  const store = createFirestoreStore(db);
  const input = largeMutation('large');
  const saved = await store.save(input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.payload.lotteries.length, 520);
  assert.equal(saved.payload.auditLog.length, 2601);
  const docs = db.dump();
  const root = docs.get('torecaVaultV2/canonical');
  assert.equal(root.storageFormat, 'chunked-v1');
  assert.ok(root.segmentIds.length >= 2);
  for (const id of root.segmentIds) {
    const doc = docs.get('torecaVaultV2/canonical/segments/' + id);
    assert.ok(Buffer.byteLength(JSON.stringify(doc), 'utf8') < 900_000);
  }
});

test('Firestore store rejects a chunked snapshot when a segment is missing', async () => {
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() });
  const store = createFirestoreStore(db);
  await store.save(largeMutation('large-missing'));
  const root = db.dump().get('torecaVaultV2/canonical');
  db.remove('torecaVaultV2/canonical/segments/' + root.segmentIds[0]);
  await assert.rejects(store.read(), /missing a chunk/);
});

test('Firestore store rejects a chunked snapshot when segment content is altered', async () => {
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() });
  const store = createFirestoreStore(db);
  await store.save(largeMutation('large-corrupt'));
  const root = db.dump().get('torecaVaultV2/canonical');
  const path = 'torecaVaultV2/canonical/segments/' + root.segmentIds[0];
  db.mutate(path, (segment) => ({
    ...segment,
    items: segment.items.map((item, index) => index === 0 ? { ...item, memo: item.memo + '-tampered' } : item)
  }));
  await assert.rejects(store.read(), /snapshot hash does not match/);
});

test('Firestore store rejects a segment from a different revision', async () => {
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() });
  const store = createFirestoreStore(db);
  await store.save(largeMutation('large-stale-segment'));
  const root = db.dump().get('torecaVaultV2/canonical');
  const path = 'torecaVaultV2/canonical/segments/' + root.segmentIds[0];
  db.mutate(path, (segment) => ({ ...segment, revision: segment.revision - 1 }));
  await assert.rejects(store.read(), /chunk is invalid/);
});

test('Firestore store atomically replaces all chunks when a large snapshot advances', async () => {
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: emptyV2() });
  const store = createFirestoreStore(db);
  await store.save(largeMutation('large-revision-one'));
  const next = largeMutation('large-revision-two', 1);
  const saved = await store.save(next);
  assert.equal(saved.revision, 2);
  assert.equal(saved.lastMutationId, 'large-revision-two');
  assert.deepEqual(saved.payload, next.payload);
  const docs = db.dump();
  const root = docs.get('torecaVaultV2/canonical');
  for (const id of root.segmentIds) {
    assert.equal(docs.get('torecaVaultV2/canonical/segments/' + id).revision, 2);
  }
});

test('Firestore store safely returns to single-document form and removes obsolete chunks', async () => {
  const initial = emptyV2();
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial });
  const store = createFirestoreStore(db);
  await store.save(largeMutation('large'));
  const large = await store.read();
  const smaller = emptyV2();
  smaller.revision = large.revision + 1;
  smaller.lastMutationId = 'small';
  smaller.auditLog = [...large.payload.auditLog.slice(-1), { mutationId: 'small', revision: 2 }];
  await store.save({ expectedRevision: large.revision, mutationId: 'small', payload: smaller });
  const docs = db.dump();
  assert.equal(docs.get('torecaVaultV2/canonical').storageFormat, undefined);
  assert.equal(docs.get('torecaVaultV2/canonical').revision, 2);
  assert.equal([...docs.keys()].filter((path) => path.includes('/segments/')).length, 0);
});

test('Firestore store fails closed on an oversized atomic value and preserves prior state', async () => {
  const initial = emptyV2();
  const db = fakeFirestore({ schemaVersion: 2, revision: 0, lastMutationId: '', payload: initial });
  const store = createFirestoreStore(db);
  const input = purchaseMutation('large');
  input.payload.automation.largeDiagnostic = 'x'.repeat(900_001);
  await assert.rejects(store.save(input), StateTooLarge);
  const current = await store.read();
  assert.equal(current.revision, 0);
  assert.equal(current.payload.transactions.length, 0);
});

