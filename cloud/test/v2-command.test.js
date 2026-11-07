import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2, realizedProfit, validateState } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';

const run = (state, command) => applyChatCommand(state, command, { now: Date.parse('2026-11-03T00:00:00Z') });

test('purchase uses explicit actual unit cost and an exact resend does not add cost or revision', () => {
  const state = emptyV2();
  const command = { type: 'purchase', requestId: 'p-1', product: 'MEGAドリームex', category: 'BOX', condition: 'あり', quantity: 1, unitCost: 34300, date: '2026-11-01', store: '店' };
  const first = run(state, command);
  assert.equal(first.state.revision, 1);
  assert.equal(first.state.transactions.length, 1);
  assert.equal(first.state.transactions[0].total, 34300);
  assert.equal(first.state.inventoryLots[0].unitCost, 34300);
  const duplicate = run(first.state, command);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.revision, 1);
  assert.equal(duplicate.state.transactions.length, 1);
  assert.equal(state.revision, 0);
});

test('sale consumes FIFO inventory, preserves cost basis, and calculates realized profit', () => {
  let state = run(emptyV2(), { type: 'purchase', requestId: 'p-1', product: 'MEGAドリームex', category: 'BOX', condition: 'あり', quantity: 1, unitCost: 34300, date: '2026-10-01', store: '店' }).state;
  const sale = run(state, { type: 'sale', requestId: 's-1', product: 'MEGAドリームex', category: 'BOX', condition: 'あり', quantity: 1, unitPrice: 55300, date: '2026-11-01', store: '買取店' });
  state = sale.state;
  assert.equal(state.inventoryLots.length, 0);
  assert.equal(state.transactions.at(-1).acquisitionCost, 34300);
  assert.equal(realizedProfit(state), 21000);
  assert.equal(state.revision, 2);
  validateState(state);
});

test('sale failures and ambiguous conditions leave the input state unchanged', () => {
  let state = run(emptyV2(), { type: 'purchase', requestId: 'p-a', product: '商品', category: 'BOX', condition: 'あり', quantity: 1, unitCost: 100, date: '2026-10-01' }).state;
  state = run(state, { type: 'purchase', requestId: 'p-b', product: '商品', category: 'BOX', condition: 'なし', quantity: 1, unitCost: 90, date: '2026-10-02' }).state;
  const before = structuredClone(state);
  assert.throws(() => run(state, { type: 'sale', requestId: 's-amb', product: '商品', category: 'BOX', quantity: 1, unitPrice: 200, date: '2026-11-01', store: '買取店' }), /ambiguous/);
  assert.deepEqual(state, before);
  assert.throws(() => run(state, { type: 'sale', requestId: 's-short', product: '別商品', category: 'BOX', condition: 'あり', quantity: 1, unitPrice: 200, date: '2026-11-01', store: '買取店' }), /not found/);
  assert.deepEqual(state, before);
});

test('opening packs removes sealed stock but retains the purchase history and acquisition cost', () => {
  const bought = run(emptyV2(), { type: 'purchase', requestId: 'p-pack', product: '拡張パック', category: 'パック', condition: '', quantity: 3, unitCost: 180, date: '2026-11-01', store: '店' }).state;
  const opened = run(bought, { type: 'open-packs', requestId: 'open-1', product: '拡張パック', quantity: 2, sourcePurchaseRequestId: 'p-pack', date: '2026-11-02' }).state;
  assert.equal(opened.inventoryLots.length, 1);
  assert.equal(opened.inventoryLots[0].quantity, 1);
  assert.equal(opened.transactions.length, 2);
  assert.equal(opened.transactions[0].type, 'purchase');
  assert.equal(opened.transactions[1].type, 'opening');
  assert.equal(opened.transactions[1].acquisitionCost, 360);
  assert.equal(opened.revision, 2);
});

test('opening pack stock across multiple source lots requires an explicit source selector', () => {
  let state = run(emptyV2(), { type: 'purchase', requestId: 'p1', product: '同じパック', category: 'パック', quantity: 1, unitCost: 100, date: '2026-11-01', store: '店A' }).state;
  state = run(state, { type: 'purchase', requestId: 'p2', product: '同じパック', category: 'パック', quantity: 1, unitCost: 120, date: '2026-11-02', store: '店B' }).state;
  const before = structuredClone(state);
  assert.throws(() => run(state, { type: 'open-packs', requestId: 'open-x', product: '同じパック', quantity: 1, date: '2026-11-03' }), /ambiguous/);
  assert.deepEqual(state, before);
});

test('opening a box records the opening and acquired single at zero cost', () => {
  const bought = run(emptyV2(), { type: 'purchase', requestId: 'p-box', product: 'セット商品', category: 'BOX', condition: 'あり', quantity: 1, unitCost: 7200, date: '2026-10-01', store: '店' }).state;
  const opened = run(bought, { type: 'purchase', requestId: 'card-1', product: 'ピカチュウ', category: 'カード', condition: '対象外', quantity: 1, unitCost: 0, cardSet: 'M6a 001/100', openingBoxProduct: 'セット商品', date: '2026-11-01' }).state;
  assert.equal(opened.inventoryLots.length, 1);
  assert.equal(opened.inventoryLots[0].product, 'ピカチュウ');
  assert.equal(opened.inventoryLots[0].unitCost, 0);
  assert.equal(opened.transactions.find((tx) => tx.type === 'purchase' && tx.product === 'セット商品').price, 7200);
  assert.equal(opened.transactions.find((tx) => tx.type === 'opening').acquisitionCost, 7200);
  assert.equal(opened.revision, 2);
});

test('screenshot lottery application creates a lottery row and no purchase or inventory', () => {
  const state = run(emptyV2(), { type: 'lottery', requestId: 'lot-1', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-03', evidenceType: 'screenshot' }).state;
  assert.equal(state.lotteries.length, 1);
  assert.equal(state.lotteries[0].evidenceType, 'screenshot');
  assert.equal(state.lotteries[0].status, '応募済');
  assert.equal(state.transactions.length, 0);
  assert.equal(state.inventoryLots.length, 0);
});

test('exact lottery result requires one unambiguous application and is idempotent', () => {
  let state = run(emptyV2(), { type: 'lottery', requestId: 'lot-1', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-01', owner: '本人' }).state;
  const result = run(state, { type: 'lottery-result-exact', requestId: 'result-1', title: '商品A', store: '店舗A', owner: '本人', status: '当選', resultDate: '2026-11-03' });
  state = result.state;
  assert.equal(state.lotteries[0].status, '当選');
  assert.equal(state.lotteries[0].receiptStatus, '未受取');
  assert.equal(state.transactions.length, 0);
  assert.equal(run(state, { type: 'lottery-result-exact', requestId: 'result-1', title: '商品A', store: '店舗A', owner: '本人', status: '当選', resultDate: '2026-11-03' }).duplicate, true);
});

test('lottery receipt requires one win and does not create purchase or inventory', () => {
  let state = run(emptyV2(), { type: 'lottery', requestId: 'lot-1', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-01', owner: '本人' }).state;
  state = run(state, { type: 'lottery-result-exact', requestId: 'result-1', title: '商品A', store: '店舗A', owner: '本人', status: '当選', resultDate: '2026-11-03' }).state;
  state = run(state, { type: 'lottery-receipt', requestId: 'receipt-1', title: '商品A', store: '店舗A', owner: '本人', receivedDate: '2026-11-04' }).state;
  assert.equal(state.lotteries[0].status, '購入済');
  assert.equal(state.lotteries[0].receiptStatus, '受取済み');
  assert.equal(state.transactions.length, 0);
  assert.equal(state.inventoryLots.length, 0);
});

test('lottery result and bulk updates fail closed around ambiguous or purchased rows', () => {
  let state = run(emptyV2(), { type: 'lottery', requestId: 'lot-1', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-01', owner: '本人' }).state;
  state = run(state, { type: 'lottery', requestId: 'lot-2', title: '商品A', store: '店舗A', status: '応募済', applicationDate: '2026-11-01', owner: '配偶者' }).state;
  const before = structuredClone(state);
  assert.throws(() => run(state, { type: 'lottery-result-exact', requestId: 'result-x', title: '商品A', store: '店舗A', status: '当選', resultDate: '2026-11-03' }), /ambiguous/);
  assert.deepEqual(state, before);
  state.lotteries[0].resultDate = '2026-11-03';
  state.lotteries[1].resultDate = '2026-11-03';
  state.lotteries[0].status = '購入済';
  state.lotteries[0].receiptStatus = '受取済み';
  const purchasedBefore = structuredClone(state);
  assert.throws(() => run(state, { type: 'lottery-bulk', requestId: 'bulk-1', resultDates: ['2026-11-03'], status: '落選' }), /purchased or received/);
  assert.deepEqual(state, purchasedBefore);
});

test('unknown command variants remain review-only and invalid payloads fail closed', () => {
  assert.throws(() => run(emptyV2(), { type: 'repair-receipt-sale', requestId: 'repair-1' }), /not implemented/);
  assert.throws(() => run(emptyV2(), { type: 'purchase', requestId: 'bad/../../id', product: 'x' }), /requestId/);
  assert.throws(() => run(emptyV2(), { type: 'purchase', requestId: 'p-1', product: 'x', category: 'BOX', quantity: 1, unitCost: -1, date: '2026-11-03' }), /unitCost/);
  assert.throws(() => run(emptyV2(), { type: 'purchase', requestId: 'p-open', product: 'シングル', category: 'カード', quantity: 1, unitCost: 500, cardSet: 'M6a 001/100', openingBoxProduct: 'BOX', date: '2026-11-03' }), /zero cost/);
  assert.throws(() => run(emptyV2(), { type: 'lottery', requestId: 'lot-1', title: 'x', store: 'y', status: '当選', applicationDate: '2026-11-03' }), /lottery application/);
});
