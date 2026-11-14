import test from 'node:test';
import assert from 'node:assert/strict';
import { buybackForLot, buybackOffersForLot, buybackSourceUrl } from '../src/buyback-quotes.js';
import { renderDashboard } from '../src/dashboard-view.js';

const NOW = new Date('2026-11-14T06:00:00.000Z');
const lot = { id: 'lot-1', product: '30th CELEBRATION', productKey: '30th CELEBRATION',
  category: 'BOX', condition: 'あり', quantity: 2, unitCost: 7200 };
const mimi = {
  productKey: '30th CELEBRATION', category: 'BOX', condition: 'シュリンクあり',
  price: 18200, sourceStore: '買取ミミ', status: 'verified', unit: 'box',
  postedAt: '2026-11-14T02:00:00.000Z', validUntil: '2026-11-14',
  postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456789'
};
const kuro = {
  ...mimi, price: 18500, sourceStore: 'トレカショップKURO',
  postUrl: 'https://x.com/kuro_tcg/status/1234567890123456780'
};

test('verified same-day store buyback offers beat the MSRP, but are not derived from it', () => {
  const quotes = [
    { ...mimi, price: 7200, sourceStore: '公式定価' },
    { ...mimi, price: 7200, sourceStore: 'ポケモン公式' },
    { ...mimi, price: 7200, sourceStore: '参考' },
    { ...mimi, price: 7200, source: '公式定価', sourceStore: '買取ミミ' },
    { ...mimi, price: 7200, source: '買取ミミ', priceBasis: 'MSRP' },
    { ...mimi, price: 7200, source: '買取ミミ', quoteType: '販売価格' },
    mimi, kuro
  ];
  const answer = buybackForLot(quotes, lot, NOW);
  assert.equal(answer.status, 'current');
  assert.equal(answer.price, 18500);
  assert.equal(answer.quote.sourceStore, 'トレカショップKURO');
  assert.match(buybackSourceUrl(answer.quote), /^https:\/\/x\.com\/kuro_tcg\/status\//);
});

test('fullwidth and shrink condition names match, but no-shrink, packs and cartons never substitute', () => {
  const wrong = [
    { ...mimi, condition: 'なし', price: 30000 },
    { ...mimi, unit: 'case', price: 250000 },
    { ...mimi, category: 'パック', price: 10000 },
    { ...mimi, productKey: '30th CELEBRATION 9種カードセット', price: 20000 }
  ];
  assert.equal(buybackForLot(wrong, lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...mimi, condition: 'ｼｭﾘﾝｸあり' }], lot, NOW).status, 'current');
});

test('quotes with expired date, stale marker, no primary source link or unverified evidence are not current', () => {
  for (const change of [
    { status: 'review' },
    { status: 'availability_unconfirmed' },
    { status: '' },
    { fresh: false },
    { validUntil: '2026-11-13' },
    { postedAt: '2026-11-12T03:00:00Z', validUntil: '' },
    { postUrl: 'https://x.com/not_the_shop/status/1234567890' },
    { postUrl: 'javascript:alert(1)' },
    { postUrl: '' }
  ]) {
    const result = buybackForLot([{ ...mimi, ...change }], lot, NOW);
    assert.notEqual(result.status, 'current', JSON.stringify(change));
  }
  assert.equal(buybackForLot([mimi], lot, new Date('2026-11-15T06:00:00.000Z')).status, 'stale');
});

test('limited buybacks are excluded unless pickup eligibility is verified', () => {
  assert.notEqual(buybackForLot([{ ...mimi, quoteType: 'pickup_limited' }], lot, NOW).status, 'current');
  assert.equal(buybackForLot([{ ...mimi, quoteType: 'pickup_limited', availabilityConfirmed: true }], lot, NOW).status, 'current');
});

test('dashboard never substitutes MSRP or purchase cost for buyback price and separates partial valuation', () => {
  const base = { schemaVersion: 2, inventoryLots: [lot], marketQuotes: [],
    transactions: [], lotteries: [] };
  const unpriced = renderDashboard(base, 1, '2026-11', NOW);
  assert.match(unpriced, /参考買取評価額/);
  assert.match(unpriced, /未算定/);
  assert.match(unpriced, /相場未取得/);
  assert.match(unpriced, /買取相場未取得/);
  assert.match(unpriced, /原価/);
  assert.doesNotMatch(unpriced, /原価で代用/);
  const msrp = renderDashboard({
    ...base, marketQuotes: [{ lotId: 'lot-1', category: 'BOX', condition: 'あり',
      price: 7200, source: '公式定価', status: 'verified', postedAt: '2026-11-14',
      postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456789' }]
  }, 1, '2026-11', NOW);
  assert.match(msrp, /買取相場未取得/);
  assert.match(msrp, /未算定/);
  const priced = renderDashboard({ ...base, marketQuotes: [mimi] }, 1, '2026-11', NOW);
  assert.match(priced, /参考買取価格/);
  assert.match(priced, /18,200/);
  assert.match(priced, /36,400/);
  assert.match(priced, /22,000/); // (18,200 - 7,200) × 2
  assert.match(priced, /元投稿/);
});

test('stale quote may be shown for context but cannot be used as live asset valuation', () => {
  const sample = { schemaVersion: 2, inventoryLots: [lot],
    marketQuotes: [{ ...mimi, postedAt: '2026-11-13T02:00:00Z', validUntil: '2026-11-13' }],
    transactions: [], lotteries: [] };
  const html = renderDashboard(sample, 1, '2026-11', NOW);
  assert.match(html, /旧価格/);
  assert.match(html, /過去の買取提示額・要更新/);
  assert.match(html, /未算定/);
  assert.match(html, /相場未取得/);
  assert.doesNotMatch(html, /参考資産額は相場未取得/);
});

test('partially priced inventory never computes profit for unknown-cost lot', () => {
  const noCost = { id: 'lot-other', product: 'Card X', productKey: 'Card X', category: 'カード',
    condition: '', quantity: 1, unitCost: null };
  const singleQuote = {
    lotId: noCost.id, productKey: 'Card X', category: 'カード', condition: '', unit: 'card', price: 2500, status: 'verified',
    sourceStore: 'カードラッシュ', sourceUrl: 'https://www.cardrush-pokemon.jp/',
    postedAt: '2026-11-14T03:00:00Z', validUntil: '2026-11-14'
  };
  const html = renderDashboard({
    schemaVersion: 2, inventoryLots: [lot, noCost], marketQuotes: [mimi, singleQuote],
    transactions: [], lotteries: []
  }, 2, '2026-11', NOW);
  assert.match(html, /38,900/);
  assert.match(html, /参考評価差額/);
  assert.match(html, /22,000/);
  assert.doesNotMatch(html, /24,500/);
});

test('later lower quote from the same shop supersedes a still-valid older high quote', () => {
  const previous = { ...mimi, price: 24000, postedAt: '2026-11-14T02:00:00Z' };
  const revised = { ...mimi, price: 18000, postedAt: '2026-11-14T04:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456700' };
  const picked = buybackForLot([previous, revised], lot, NOW);
  assert.equal(picked.status, 'current');
  assert.equal(picked.price, 18000);
  assert.equal(buybackOffersForLot([previous, revised], lot, NOW).length, 1);
});

test('same-time contradictory posts from one shop are omitted, but other shops still count', () => {
  const contradictory = { ...mimi, price: 29000,
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456701' };
  const offers = buybackOffersForLot([mimi, contradictory, kuro], lot, NOW);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].sourceStore, 'トレカショップKURO');
  assert.equal(buybackForLot([mimi, contradictory, kuro], lot, NOW).price, 18500);
});

test('inventory shows distinct shop offers and original post links without substituting cost', () => {
  const html = renderDashboard({
    schemaVersion: 2, inventoryLots: [lot],
    marketQuotes: [mimi, kuro], transactions: [], lotteries: []
  }, 1, '2026-11', NOW);
  assert.match(html, /店舗別の有効な参考買取価格/);
  assert.match(html, /買取ミミ/);
  assert.match(html, /トレカショップKURO/);
  assert.match(html, /18,200/);
  assert.match(html, /18,500/);
  assert.match(html, /出典/);
  assert.match(html, /mimi_kaitori\/status/);
  assert.match(html, /kuro_tcg\/status/);
});


test('a matching lotId does not override a contradictory category, product or selling unit', () => {
  const keyed = { ...mimi, lotId: 'lot-1', productKey: lot.productKey,
    category: lot.category, condition: lot.condition };
  assert.equal(buybackForLot([keyed], lot, NOW).status, 'current');
  assert.equal(buybackForLot([{ ...keyed, category: 'カード' }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, productKey: 'different-product' }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, unit: 'card' }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, unit: 'pack' }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, unit: '' }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, unit: undefined }], lot, NOW).status, 'missing');
  assert.equal(buybackForLot([{ ...keyed, productKey: undefined }], lot, NOW).status, 'missing');
});
