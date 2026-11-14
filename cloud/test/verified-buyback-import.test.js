import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import { buybackForLot } from '../src/buyback-quotes.js';
import { previewVerifiedBuybackImport, commitVerifiedBuybackImport } from '../src/verified-buyback-import.js';

const NOW = new Date('2026-11-14T06:00:00Z');
const REQUEST = 'verified-buyback:2026-11-14:manual-batch-a';
const lotBase = { id: 'purchase-1', type: 'purchase', product: 'BOX A', productKey: 'box-a',
  category: 'BOX', condition: 'あり', quantity: 2, unitCost: 7000, date: '2026-11-14' };
const mimi = {
  productKey: 'box-a', category: 'BOX', condition: 'シュリンクあり',
  unit: 'box', price: 18000, sourceStore: '買取ミミ',
  postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456789',
  postedAt: '2026-11-14T02:00:00Z', validUntil: '2026-11-14',
  status: 'verified'
};
const kuro = {
  ...mimi, sourceStore: 'トレカショップKURO', price: 18500,
  postUrl: 'https://x.com/kuro_tcg/status/1234567890123456780'
};
function state() { return applyTransaction(emptyV2(), lotBase, 'initial-purchase'); }
function fakeStore(original = state()) {
  let current = structuredClone(original);
  let writes = 0;
  return {
    get writes() { return writes; },
    async read() { return { revision: current.revision, payload: structuredClone(current) }; },
    async save({ expectedRevision, mutationId, payload }) {
      assert.equal(expectedRevision, current.revision, 'CAS revision required');
      assert.equal(payload.lastMutationId, mutationId);
      current = structuredClone(payload);
      writes++;
    }
  };
}

test('preview is read-only; two verified shops are retained and higher quote values an inventory lot', async () => {
  const s = fakeStore();
  const args = { store: s, records: [mimi, kuro], mutationId: REQUEST,
    expectedRevision: 1, now: NOW };
  const preview = await commitVerifiedBuybackImport(args);
  assert.deepEqual(preview, { revisionBefore: 1, revisionAfter: 2,
    added: 2, superseded: 0, skipped: 0, matchingLots: 1,
    idempotent: false, applied: false });
  assert.equal(s.writes, 0);
  const saved = await commitVerifiedBuybackImport({ ...args, apply: true });
  assert.equal(saved.applied, true);
  assert.equal(saved.readbackVerified, true);
  assert.equal(s.writes, 1);
  const current = (await s.read()).payload;
  assert.equal(current.marketQuotes.length, 2);
  assert.equal(current.inventoryLots[0].quantity, 2);
  assert.equal(current.inventoryLots[0].unitCost, 7000);
  assert.equal(current.transactions.length, 1);
  assert.equal(current.lotteries.length, 0);
  assert.equal(buybackForLot(current.marketQuotes, current.inventoryLots[0], NOW).price, 18500);
  const rerun = await commitVerifiedBuybackImport({ ...args, expectedRevision: 2, apply: true });
  assert.equal(rerun.idempotent, true);
  assert.equal(s.writes, 1);
});

test('later verified same-store posting supersedes only the older posting, not competitors', () => {
  const first = previewVerifiedBuybackImport(state(), [mimi, kuro],
    { expectedRevision: 1, mutationId: REQUEST, now: NOW });
  const later = { ...mimi, price: 17500,
    postedAt: '2026-11-14T03:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456711' };
  const updated = previewVerifiedBuybackImport(first.state, [later],
    { expectedRevision: 2, mutationId: REQUEST + '-later', now: NOW });
  assert.equal(updated.added, 1);
  assert.equal(updated.replaced, 1);
  assert.equal(updated.state.marketQuotes.length, 3);
  assert.equal(updated.state.marketQuotes[0].status, 'superseded');
  assert.equal(updated.state.marketQuotes[1].status, 'verified');
  assert.equal(updated.state.marketQuotes[1].sourceStore, 'トレカショップKURO');
  assert.equal(buybackForLot(updated.state.marketQuotes, updated.state.inventoryLots[0], NOW).price, 18500);
});

test('MSRP, wrong state, unsupported shop, old post, missing provenance and missing inventory are rejected', () => {
  const invalid = [
    { ...mimi, sourceStore: '公式定価' },
    { ...mimi, price: 7000, sourceStore: 'ポケモン公式' },
    { ...mimi, condition: 'なし' },
    { ...mimi, unit: 'case' },
    { ...mimi, productKey: 'unrelated' },
    { ...mimi, validUntil: '2026-11-13' },
    { ...mimi, postUrl: 'https://x.com/other/status/1234567890123456789' },
    { ...mimi, status: 'review' },
    { ...mimi, quoteType: 'pickup_limited', availabilityConfirmed: false },
    { ...mimi, postedAt: '' },
    { ...mimi, unit: '' },
    { ...mimi, price: '18000' },
    { ...mimi, price: 0 }
  ];
  for (const record of invalid) {
    assert.throws(() => previewVerifiedBuybackImport(state(), [record],
      { expectedRevision: 1, mutationId: REQUEST, now: NOW }), /evidence|expired|source|unit|invalid|match|price/);
  }
});

test('same post repeated, older shop price and reused mutationId with new content fail closed', () => {
  assert.throws(() => previewVerifiedBuybackImport(state(), [mimi, mimi],
    { expectedRevision: 1, mutationId: REQUEST, now: NOW }), /repeated/);
  const first = previewVerifiedBuybackImport(state(), [mimi],
    { expectedRevision: 1, mutationId: REQUEST, now: NOW });
  assert.throws(() => previewVerifiedBuybackImport(first.state,
    [{ ...mimi, price: 17000, postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456701',
      postedAt: '2026-11-14T01:00:00Z' }],
    { expectedRevision: 2, mutationId: REQUEST + '-older', now: NOW }), /not later/);
  assert.throws(() => previewVerifiedBuybackImport(first.state, [kuro],
    { expectedRevision: 2, mutationId: REQUEST, now: NOW }), /mutationId collision/);
  assert.throws(() => previewVerifiedBuybackImport(first.state, [mimi],
    { expectedRevision: 1, mutationId: REQUEST, now: NOW }), /revision differs/);
});

test('previously unverified prices or purchase cost never become evidence without a real shop post', () => {
  const s = state();
  s.marketQuotes.push({ productKey: 'box-a', category: 'BOX', condition: 'あり',
    price: 7000, source: '希望小売価格', fresh: true });
  const out = previewVerifiedBuybackImport(s, [kuro],
    { expectedRevision: 1, mutationId: REQUEST, now: NOW });
  assert.equal(out.state.marketQuotes.length, 2);
  assert.equal(out.state.marketQuotes[0].price, 7000);
  assert.equal(out.state.marketQuotes[0].source, '希望小売価格');
  assert.equal(buybackForLot(out.state.marketQuotes, out.state.inventoryLots[0], NOW).price, 18500);
});
