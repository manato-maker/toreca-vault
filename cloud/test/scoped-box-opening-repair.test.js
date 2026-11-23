import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2 } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';
import { planScopedBoxOpeningRepair, applyScopedBoxOpeningRepair } from '../src/scoped-box-opening-repair.js';

const openingRequest = 'scoped-opening-1';
const product = 'Example Product / Model 1';
const date = '2026-11-22';
const purchase = (requestId, store) => ({
  requestId, type: 'purchase', category: 'BOX', product, quantity: 1,
  unitCost: 5760, date, store
});
const row = (n, command, status) => ({ rowNumber: n,
  values: [command.requestId, JSON.stringify(command), '', status] });

function fixture() {
  let state = emptyV2();
  for (const p of [purchase('sold-source', 'Sold elsewhere'), purchase('target-a', 'Shop A'),
    purchase('target-b', 'Shop B')]) state = applyChatCommand(state, p).state;
  // The unrelated lot was sold in an earlier event; no opening may touch it.
  state = applyChatCommand(state, { requestId: 'sold-lot', type: 'sale', product,
    category: 'BOX', quantity: 1, unitPrice: 9000, store: 'Buyer', date }).state;
  const canonical = { payload: state, revision: state.revision, lastMutationId: state.lastMutationId };
  const original = { requestId: openingRequest, type: 'open-box', product, quantity: 2,
    date, memo: 'Shop AとShop Bで購入したそれぞれ1BOXを開封した' };
  return { canonical, openingRow: row(64, original, 'new'),
    purchaseRows: [row(56, purchase('target-a', 'Shop A'), 'v2-applied'),
      row(57, purchase('target-b', 'Shop B'), 'v2-applied')],
    excludedRequestIds: ['sold-source'] };
}

function memoryStore(canonical) {
  let current = structuredClone(canonical);
  let failReadback = false;
  return {
    async read() {
      if (failReadback) return { ...structuredClone(current), lastMutationId: 'invalid' };
      return structuredClone(current);
    },
    async save({ expectedRevision, mutationId, payload }) {
      if (expectedRevision !== current.revision) {
        const err = new Error('revision changed'); err.name = 'RevisionConflict'; throw err;
      }
      current = { payload: structuredClone(payload), revision: payload.revision, lastMutationId: mutationId };
      return structuredClone(current);
    },
    setReadbackMismatch() { failReadback = true; },
    get() { return structuredClone(current); }
  };
}

test('plans the original opening request with exact source lots, without mutating rows or canonical', () => {
  const input = fixture();
  const before = structuredClone(input);
  const plan = planScopedBoxOpeningRepair(input);
  assert.equal(plan.expectedRevision, 4);
  assert.equal(plan.quantity, 2);
  assert.equal(plan.expectedCost, 11520);
  assert.equal(plan.mutationId, 'chat:open-box:scoped-opening-1');
  assert.deepEqual(plan.sourceLots.map(source => source.purchaseRequestId), ['target-a', 'target-b']);
  assert.deepEqual(plan.payload.inventoryLots.map(lot => lot.requestId), []);
  assert.equal(plan.payload.transactions.filter(tx => tx.type === 'purchase').length, 3);
  assert.deepEqual(input, before);
});

test('refuses ambiguous, different-source or incomplete original Intake evidence', () => {
  const input = fixture();
  const changed = structuredClone(input);
  changed.openingRow.values[3] = 'review';
  assert.throws(() => planScopedBoxOpeningRepair(changed), /status/);
  const duplicate = structuredClone(input);
  duplicate.purchaseRows[1] = duplicate.purchaseRows[0];
  assert.throws(() => planScopedBoxOpeningRepair(duplicate), /purchase row/);
  const excluded = structuredClone(input);
  excluded.excludedRequestIds.push('target-a');
  assert.throws(() => planScopedBoxOpeningRepair(excluded), /purchase row/);
  const otherStore = structuredClone(input);
  otherStore.purchaseRows[0] = row(56, purchase('target-a', 'Unreported shop'), 'v2-applied');
  assert.throws(() => planScopedBoxOpeningRepair(otherStore), /purchase row/);
  const wrongCost = structuredClone(input);
  wrongCost.purchaseRows[0] = row(56, { ...purchase('target-a', 'Shop A'), unitCost: 9999 }, 'v2-applied');
  assert.throws(() => planScopedBoxOpeningRepair(wrongCost), /canonical/);
  const stale = structuredClone(input);
  stale.canonical.revision += 1;
  assert.throws(() => planScopedBoxOpeningRepair(stale), /revision/);
});

test('scoped repair requires CAS and checks persisted opening and remaining lots', async () => {
  const input = fixture();
  const store = memoryStore(input.canonical);
  const plan = planScopedBoxOpeningRepair(input);
  const applied = await applyScopedBoxOpeningRepair({ store, plan });
  assert.deepEqual(applied, { status: 'canonical-readback-verified', revision: 5, quantity: 2 });
  assert.equal(store.get().payload.transactions.filter(tx => tx.id === plan.transactionId).length, 1);
  await assert.rejects(() => applyScopedBoxOpeningRepair({ store, plan }), /revision/);
  assert.throws(() => planScopedBoxOpeningRepair({ ...input, canonical: store.get() }), /canonical|already applied/);
});

test('concurrent revision change rejects rather than re-saving an old plan', async () => {
  const input = fixture();
  const store = memoryStore(input.canonical);
  const plan = planScopedBoxOpeningRepair(input);
  const another = applyChatCommand(input.canonical.payload, { requestId: 'other', type: 'sale-aggregate',
    category: 'カード', product: 'Other card bundle', quantity: 1, unitPrice: 50,
    date, store: 'Buyer' });
  await store.save({ expectedRevision: input.canonical.revision, mutationId: another.mutationId, payload: another.state });
  await assert.rejects(() => applyScopedBoxOpeningRepair({ store, plan }), /revision/);
});

test('independent readback mismatch cannot be reported as repair completion', async () => {
  const input = fixture();
  const store = memoryStore(input.canonical);
  const plan = planScopedBoxOpeningRepair(input);
  const baseSave = store.save;
  store.save = async (args) => { const saved = await baseSave(args); store.setReadbackMismatch(); return saved; };
  await assert.rejects(() => applyScopedBoxOpeningRepair({ store, plan }), /readback/);
});
