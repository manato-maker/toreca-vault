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

test('opening boxes removes BOX stock and aggregate sales record proceeds without individual card lots', () => {
  let state = run(emptyV2(), {
    type: 'purchase', requestId: 'op18-furuichi', product: '神の支配【OP-18】',
    category: 'BOX', quantity: 1, unitCost: 5760, date: '2026-11-22', store: 'ふるいち 久宝寺店'
  }).state;
  state = run(state, {
    type: 'purchase', requestId: 'op18-bic', product: '神の支配【OP-18】',
    category: 'BOX', quantity: 1, unitCost: 5760, date: '2026-11-22', store: 'ビックカメラ アリオ八尾店'
  }).state;
  const opened = run(state, {
    type: 'open-box', requestId: 'op18-open-2', product: '神の支配【OP-18】',
    quantity: 2, date: '2026-11-22', expectedRevision: state.revision,
    sourceLots: [
      { lotId: 'chat-purchase-op18-furuichi-lot', purchaseRequestId: 'op18-furuichi', store: 'ふるいち 久宝寺店', acquiredAt: '2026-11-22', unitCost: 5760, quantity: 1 },
      { lotId: 'chat-purchase-op18-bic-lot', purchaseRequestId: 'op18-bic', store: 'ビックカメラ アリオ八尾店', acquiredAt: '2026-11-22', unitCost: 5760, quantity: 1 }
    ]
  });
  state = opened.state;
  assert.equal(state.inventoryLots.length, 0);
  const opening = state.transactions.find((tx) => tx.requestId === 'op18-open-2');
  assert.equal(opening.type, 'opening');
  assert.equal(opening.quantity, 2);
  assert.equal(opening.acquisitionCost, 11520);
  assert.deepEqual(opening.sourcePurchaseRequestIds, ['op18-furuichi', 'op18-bic']);
  assert.deepEqual(opening.sourceLotIds, ['chat-purchase-op18-furuichi-lot', 'chat-purchase-op18-bic-lot']);

  const saleCommand = {
    type: 'sale-aggregate', requestId: 'op18-singles-sale',
    product: '神の支配 開封シングルまとめ売り', category: 'カード',
    quantity: 1, unitPrice: 4600, totalPrice: 4600,
    date: '2026-11-22', store: 'トレカボム大阪日本橋',
    breakdown: [
      { product: 'シャムロック聖 通常版描きおろしパラレル', amountYen: 3000 },
      { product: 'キリンガム聖 レアパラレル', amountYen: 500 },
      { product: 'その他SR・Rまとめ', amountYen: 1100 }
    ]
  };
  const sale = run(state, saleCommand);
  state = sale.state;
  const transaction = state.transactions.at(-1);
  assert.equal(transaction.type, 'sale');
  assert.equal(transaction.saleMode, 'aggregate');
  assert.equal(transaction.total, 4600);
  assert.equal(transaction.acquisitionCost, null);
  assert.equal(transaction.inventoryEffect, 'none');
  assert.equal(state.inventoryLots.length, 0);
  assert.equal(realizedProfit(state), 0);
  assert.equal(run(state, saleCommand).duplicate, true);

  const arSale = run(state, {
    type: 'sale-aggregate', requestId: 'pokemon-ar-batch-sale',
    product: 'ポケモンカード AR まとめ売り', category: 'カード',
    quantity: 30, unitPrice: 200, date: '2026-11-22', store: '買取ミミ',
    memo: 'ARをカード単位で分割せず、まとめ売りとして記録'
  });
  assert.equal(arSale.state.transactions.at(-1).total, 6000);
  assert.equal(arSale.state.transactions.at(-1).quantity, 30);
  assert.equal(arSale.state.inventoryLots.length, 0);
});

test('multi-source BOX opening fails closed without explicit source or revision', () => {
  let state = run(emptyV2(), { type: 'purchase', requestId: 'box-a', product: 'BOX X', category: 'BOX', quantity: 1, unitCost: 100, date: '2026-11-20', store: 'A' }).state;
  state = run(state, { type: 'purchase', requestId: 'box-b', product: 'BOX X', category: 'BOX', quantity: 1, unitCost: 100, date: '2026-11-21', store: 'B' }).state;
  const before = structuredClone(state);
  const request = { type: 'open-box', requestId: 'opening', product: 'BOX X', quantity: 2, date: '2026-11-22' };
  assert.throws(() => run(state, request), /ambiguous/);
  assert.deepEqual(state, before);
  const sources = [
    { lotId: 'chat-purchase-box-a-lot', purchaseRequestId: 'box-a', store: 'A', acquiredAt: '2026-11-20', unitCost: 100, quantity: 1 },
    { lotId: 'chat-purchase-box-b-lot', purchaseRequestId: 'box-b', store: 'B', acquiredAt: '2026-11-21', unitCost: 100, quantity: 1 }
  ];
  assert.throws(() => run(state, { ...request, sourceLots: sources }), /expectedRevision/);
  assert.throws(() => run(state, { ...request, expectedRevision: state.revision - 1, sourceLots: sources }), (error) => error.name === 'RevisionConflict');
  assert.throws(() => run(state, { ...request, expectedRevision: state.revision, sourceLots: [sources[0], sources[0]] }), /duplicated/);
  assert.throws(() => run(state, { ...request, expectedRevision: state.revision, sourceLots: [sources[0], {...sources[1], store: 'X'}] }), /not found/);
  assert.throws(() => run(state, { ...request, expectedRevision: state.revision, sourceLots: [sources[0], {...sources[1], unitCost: 101}] }), /not found/);
  assert.deepEqual(state, before);
  const opened = run(state, { ...request, expectedRevision: state.revision, sourceLots: sources });
  assert.equal(opened.state.inventoryLots.length, 0);
  assert.equal(opened.state.transactions.filter(tx => tx.type === 'purchase').length, 2);
  assert.equal(opened.state.transactions.at(-1).acquisitionCost, 200);
  assert.equal(run(opened.state, { ...request, expectedRevision: state.revision, sourceLots: sources }).duplicate, true);
});

test('source-bound BOX opening never consumes a different purchase even when the product matches', () => {
  const purchase = (state, requestId, store) => run(state, {type:'purchase', requestId, category:'BOX',
    product:'BOX X', quantity:1, unitCost:50, date:'2026-11-22', store}).state;
  let state = purchase(emptyV2(), 'p-mint', 'Mint Games');
  state = purchase(state, 'p-a', 'A');
  state = purchase(state, 'p-b', 'B');
  const sources = ['p-a', 'p-b'].map((id, i) => ({
    lotId: `chat-purchase-${id}-lot`, purchaseRequestId: id,
    store: i ? 'B' : 'A', acquiredAt:'2026-11-22', unitCost:50, quantity:1
  }));
  const opened = run(state, {type:'open-box',requestId:'open-two',product:'BOX X',quantity:2,
    date:'2026-11-22', expectedRevision:state.revision,sourceLots:sources});
  assert.deepEqual(opened.state.inventoryLots.map(l => l.requestId), ['p-mint']);
  assert.equal(opened.state.inventoryLots[0].quantity, 1);
  assert.equal(opened.state.transactions.at(-1).acquisitionCost, 100);
});

test('aggregate sales reject inconsistent totals without requiring box provenance', () => {
  const bought = run(emptyV2(), {
    type: 'purchase', requestId: 'box-1', product: '商品BOX',
    category: 'BOX', quantity: 1, unitCost: 1000, date: '2026-11-01', store: '店'
  }).state;
  const before = structuredClone(bought);
  assert.throws(() => run(bought, {
    type: 'sale-aggregate', requestId: 'sale-bad-total', product: '開封カードまとめ',
    category: 'カード', quantity: 1, unitPrice: 1000, totalPrice: 900,
    date: '2026-11-02', store: '買取店',
    breakdown: [{ product: 'カードA', amountYen: 900 }]
  }), /invalid aggregate sale/);
  assert.deepEqual(bought, before);
  assert.deepEqual(bought, before);
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


test('chat lottery retains official product reference and quantity but does not create purchase or stock', () => {
  const input = {
    type: 'lottery', requestId: 'lot-product-1',
    title: '公式商品A 抽選', product: '公式商品A',
    productId: 'official:example-001', store: '店舗A', status: '応募済',
    applicationDate: '2026-11-13', owner: '本人', quantity: 2, category: 'BOX',
    shrinkStatus: 'シュリンクなし', unitPrice: 6000, expectedPurchaseTotal: 12000,
    paymentStatus: '未購入・未支出', officialMsrpYen: 6000,
    officialProductUrl: 'https://example.com/products/001',
    officialMsrpCheckedAt: '2026-11-14', evidenceType: 'screenshot'
  };
  const state = run(emptyV2(), input).state;
  assert.equal(state.lotteries.length, 1);
  const lottery = state.lotteries[0];
  assert.equal(lottery.product, '公式商品A');
  assert.equal(lottery.productId, 'official:example-001');
  assert.equal(lottery.quantity, 2);
  assert.equal(lottery.category, 'BOX');
  assert.equal(lottery.shrinkStatus, 'シュリンクなし');
  assert.equal(lottery.officialMsrpYen, 6000);
  assert.equal(lottery.officialProductUrl, 'https://example.com/products/001');
  assert.equal(lottery.unitPrice, 6000);
  assert.equal(lottery.paymentStatus, '未購入・未支出');
  assert.equal(state.transactions.length, 0);
  assert.equal(state.inventoryLots.length, 0);
  assert.equal(run(state, input).duplicate, true);
});

test('same-day matching lottery application with a new ID is held for review', () => {
  const common = { type: 'lottery', title: '商品B', store: '同一店', status: '応募済',
    applicationDate: '2026-11-13', owner: '本人', deadline: '2026-11-15' };
  const state = run(emptyV2(), { ...common, requestId: 'lottery-original' }).state;
  const before = structuredClone(state);
  assert.throws(
    () => run(state, { ...common, requestId: 'lottery-another-id' }),
    /manual review required/
  );
  assert.deepEqual(state, before);
  const anotherOwner = run(state, { ...common, owner: '家族分', requestId: 'lottery-family' });
  assert.equal(anotherOwner.state.lotteries.length, 2);
});

test('invalid lottery quantity, reference prices and official URLs are rejected', () => {
  const common = { type: 'lottery', requestId: 'lot-invalid', title: '商品B', store: '店',
    status: '応募済', applicationDate: '2026-11-13' };
  for (const extra of [
    { quantity: -1 }, { quantity: 0 }, { quantity: 1.5 },
    { unitPrice: -1 }, { officialMsrpYen: -100 },
    { expectedPurchaseTotal: -1 }, { expectedPurchaseTotal: 1.5 },
    { officialProductUrl: 'http://example.com/unsafe' }
  ]) {
    assert.throws(() => run(emptyV2(), { ...common, ...extra }), /lottery|official product/);
  }
});


test('owner inventory count sets pack totals, preserves known costs, and deduplicates exact reports', () => {
  let state = run(emptyV2(), {
    type: 'purchase', requestId: 'count-source-hado', product: 'ハドウシーカー',
    category: 'パック', quantity: 30, unitCost: 200, date: '2026-11-27', store: '店舗A'
  }).state;
  state = run(state, {
    type: 'purchase', requestId: 'count-source-mega', product: 'メガブレイブ',
    category: 'パック', quantity: 1, unitCost: 180, date: '2026-11-27', store: '店舗B'
  }).state;
  const counts = [
    { product: 'ハドウシーカー', category: 'パック', quantity: 27 },
    { product: 'メガブレイブ', category: 'パック', quantity: 6 },
    { product: 'ストームエメラルダ', category: 'パック', quantity: 2 },
    { product: 'アビスアイ', category: 'パック', quantity: 2 },
    { product: 'ムニキスゼロ', category: 'パック', quantity: 6 }
  ];
  const command = {
    type: 'inventory-count', requestId: 'owner-count-2026-11-28',
    date: '2026-11-28', counts, memo: 'オーナー現物報告'
  };
  const applied = run(state, command);
  state = applied.state;
  assert.equal(applied.duplicate, false);
  assert.equal(state.revision, 3);
  for (const row of counts) {
    assert.equal(state.inventoryLots.filter(l => l.category === 'パック'
      && l.productKey === row.product).reduce((sum, l) => sum + l.quantity, 0), row.quantity);
  }
  const hadoLots = state.inventoryLots.filter(l => l.productKey === 'ハドウシーカー');
  assert.equal(hadoLots.reduce((sum, l) => sum + l.quantity, 0), 27);
  assert.equal(hadoLots.find(l => l.requestId === 'count-source-hado').quantity, 27);
  assert.equal(hadoLots.find(l => l.requestId === 'count-source-hado').unitCost, 200);
  const unpricedAdded = state.inventoryLots.filter(l => l.source === 'owner-inventory-count');
  assert.equal(unpricedAdded.reduce((sum, l) => sum + l.quantity, 0), 15);
  assert.ok(unpricedAdded.every(l => l.unitCost === null));
  assert.equal(state.transactions.filter(t => t.type === 'purchase').length, 2);
  assert.equal(state.transactions.at(-1).type, 'inventory-count');
  assert.equal(state.transactions.at(-1).quantity, 43);
  assert.equal(realizedProfit(state), 0);

  const reordered = run(state, {
    ...command, requestId: 'owner-count-repeat',
    counts: [...counts].reverse()
  });
  assert.equal(reordered.duplicate, true);
  assert.equal(reordered.state.revision, 3);
  assert.equal(reordered.state.transactions.length, 3);
  assert.equal(reordered.state.inventoryLots.reduce((sum, l) => sum + l.quantity, 0), 43);
});

test('a corrected owner inventory count replaces the prior absolute total', () => {
  const firstCounts = [{ product: 'ハドウシーカー', quantity: 27 }];
  let state = run(emptyV2(), {
    type: 'inventory-count', requestId: 'owner-count-first',
    date: '2026-11-28', counts: firstCounts
  }).state;
  state = run(state, {
    type: 'inventory-count', requestId: 'owner-count-correction',
    date: '2026-11-28', counts: [{ product: 'ハドウシーカー', quantity: 29 }]
  }).state;
  assert.equal(state.inventoryLots.reduce((sum, l) => sum + l.quantity, 0), 29);
  assert.equal(state.transactions.filter(t => t.type === 'inventory-count').length, 2);
  const before = structuredClone(state);
  assert.equal(run(state, {
    type: 'inventory-count', requestId: 'owner-count-correction-repeat',
    date: '2026-11-28', counts: [{ product: 'ハドウシーカー', quantity: 29 }]
  }).duplicate, true);
  assert.deepEqual(state, before);
});

test('owner inventory count rejects duplicate normalized products and invalid quantities without mutation', () => {
  const state = emptyV2();
  for (const counts of [
    [{ product: 'ハドウシーカー', quantity: 1 }, { product: ' ハドウシーカー ', quantity: 2 }],
    [{ product: 'ハドウシーカー', quantity: -1 }],
    [{ product: 'ハドウシーカー', quantity: 1.5 }],
    [{ product: 'ハドウシーカー', category: 'BOX', quantity: 1 }]
  ]) {
    assert.throws(() => run(state, {
      type: 'inventory-count', requestId: 'owner-count-invalid',
      date: '2026-11-28', counts
    }));
    assert.equal(state.revision, 0);
    assert.equal(state.inventoryLots.length, 0);
    assert.equal(state.transactions.length, 0);
  }
});
