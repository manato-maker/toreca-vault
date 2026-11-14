import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import { createMarketRefreshHandler, marketTargetKey, refreshMarketQuotes } from '../src/market-refresh-worker.js';

function sourcedBuyback(target, price = 1500) {
  return {
    targetKey: target.targetKey, productKey: target.productKey, category: target.category,
    condition: target.condition, unit: 'box', price, buybackYen: price,
    source: '買取ミミ', sourceStore: '買取ミミ', status: 'verified',
    postedAt: '2026-11-07T02:00:00.000Z', validUntil: '2026-11-07',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456789'
  };
}

function sampleState() {
  let state = applyTransaction(emptyV2(), {
    id: 'market-purchase', type: 'purchase', product: 'Box X', productKey: 'box-x',
    category: 'BOX', condition: 'あり', quantity: 2, unitCost: 1000, date: '2026-11-07'
  }, 'purchase-mutation');
  state.marketQuotes.push({
    productKey: 'box-x', category: 'BOX', condition: 'あり', price: 1250,
    source: 'Previous source', quotedAt: '2026-11-06T04:00:00.000Z', fresh: true
  });
  state.automation.health.marketRefresh = {
    lastAttemptAt: '2026-11-06T04:00:00.000Z',
    lastSuccessfulAt: '2026-11-06T04:00:00.000Z',
    refreshedCount: 1, staleCount: 0, status: 'healthy'
  };
  return state;
}

function memoryStore(initial) {
  let value = structuredClone(initial);
  let writes = 0;
  return {
    get writes() { return writes; },
    async read() { return { payload: structuredClone(value), revision: value.revision }; },
    async save({ expectedRevision, payload }) {
      if (expectedRevision !== value.revision) throw new Error('revision conflict');
      value = structuredClone(payload);
      writes += 1;
      return { payload: structuredClone(value), revision: value.revision };
    }
  };
}

test('market refresh records only sourced quotes and verifies revision readback', async () => {
  const initial = sampleState();
  const store = memoryStore(initial);
  let requestedTargets;
  const result = await refreshMarketQuotes({
    store,
    mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany(targets) {
      requestedTargets = targets;
      return [sourcedBuyback(targets[0], 1500)];
    } }
  });
  const saved = await store.read();
  assert.equal(requestedTargets.length, 1);
  assert.equal(requestedTargets[0].targetKey, marketTargetKey({
    productKey: 'box-x', category: 'BOX', condition: 'あり'
  }));
  assert.deepEqual(result, {
    skipped: false, revision: 2, refreshedCount: 1, staleCount: 0,
    checkedAt: '2026-11-07T04:45:00.000Z'
  });
  // The earlier unverified row is retained for audit, never overwritten as
  // if it were the same shop's verified posting.
  assert.equal(saved.payload.marketQuotes[0].price, 1250);
  assert.equal(saved.payload.marketQuotes.length, 2);
  const newQuote = saved.payload.marketQuotes.find(q => q.sourceStore === '買取ミミ');
  assert.equal(newQuote.price, 1500);
  assert.equal(newQuote.source, '買取ミミ');
  assert.equal(newQuote.priceBasis, 'buyback');
  assert.equal(newQuote.status, 'verified');
  assert.equal(newQuote.postUrl, 'https://x.com/mimi_kaitori/status/1234567890123456789');
  assert.equal(newQuote.quotedAt, '2026-11-07T02:00:00.000Z');
  assert.equal(newQuote.fresh, true);
  assert.deepEqual(saved.payload.transactions, initial.transactions);
  assert.deepEqual(saved.payload.inventoryLots, initial.inventoryLots);
  assert.deepEqual(saved.payload.automation.health.marketRefresh, {
    lastAttemptAt: '2026-11-07T04:45:00.000Z',
    lastSuccessfulAt: '2026-11-07T04:45:00.000Z',
    refreshedCount: 1, staleCount: 0, status: 'healthy'
  });
  assert.equal(store.writes, 1);
});

test('missing, invalid, or duplicated provider results preserve the prior price and mark it stale', async () => {
  for (const lookupMany of [
    async () => [],
    async targets => [{ targetKey: targets[0].targetKey, price: 'guess', source: 'Source' }],
    async targets => [
      { targetKey: targets[0].targetKey, price: 900, source: 'Source A' },
      { targetKey: targets[0].targetKey, price: 950, source: 'Source B' }
    ],
    async () => { throw new Error('private provider error'); }
  ]) {
    const state = sampleState();
    const store = memoryStore(state);
    const result = await refreshMarketQuotes({
      store, mutationId: 'market-refresh:2026-11-07', runAt: '2026-11-07T04:45:00.000Z',
      provider: { lookupMany }
    });
    const quote = (await store.read()).payload.marketQuotes[0];
    assert.equal(result.staleCount, 1);
    assert.equal(quote.price, 1250);
    assert.equal(quote.source, 'Previous source');
    assert.equal(quote.quotedAt, '2026-11-06T04:00:00.000Z');
    assert.equal(quote.lastCheckedAt, '2026-11-07T04:45:00.000Z');
    assert.equal(quote.fresh, false);
    assert.equal(quote.trend, 'stale');
    const health = (await store.read()).payload.automation.health.marketRefresh;
    assert.equal(health.status, 'degraded');
    assert.equal(health.lastSuccessfulAt, '2026-11-06T04:00:00.000Z');
  }
});

test('a missing price for a new target is not guessed and duplicate mutation IDs do not repeat provider calls', async () => {
  const state = sampleState();
  state.marketQuotes = [];
  const store = memoryStore(state);
  let calls = 0;
  const options = {
    store, mutationId: 'market-refresh:2026-11-07', runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany() { calls += 1; return []; } }
  };
  await refreshMarketQuotes(options);
  let quote = (await store.read()).payload.marketQuotes[0];
  assert.equal(quote.price, null);
  assert.equal(quote.source, null);
  assert.equal(quote.fresh, false);
  const replay = await refreshMarketQuotes(options);
  assert.equal(replay.idempotent, true);
  assert.equal(calls, 1);
  assert.equal(store.writes, 1);
});

test('market refresh skips empty inventory and rejects unsafe target limits before provider calls', async () => {
  const emptyStore = memoryStore(emptyV2());
  let calls = 0;
  const provider = { async lookupMany() { calls += 1; return []; } };
  const skipped = await refreshMarketQuotes({ store: emptyStore, provider, mutationId: 'empty-refresh' });
  assert.equal(skipped.skipped, true);
  assert.equal(emptyStore.writes, 0);
  const manyTargets = sampleState();
  manyTargets.inventoryLots.push({
    id: 'second-lot', product: 'Pack Y', productKey: 'pack-y', category: 'パック',
    condition: '', quantity: 1, unitCost: 50
  });
  const store = memoryStore(manyTargets);
  await assert.rejects(refreshMarketQuotes({ store, provider, mutationId: 'too-small-limit', maxTargets: 1 }), /target count/);
  assert.equal(calls, 0);
});

test('scheduled market handler uses the stable daily key and planned time', async () => {
  const store = memoryStore(sampleState());
  const handler = createMarketRefreshHandler({
    store,
    provider: { async lookupMany(targets) {
      return [sourcedBuyback(targets[0], 1600)];
    } }
  });
  const result = await handler({
    kind: 'market-refresh',
    jobKey: 'market-refresh:2026-11-07',
    scheduledAt: '2026-11-07T13:45:00+09:00'
  });
  assert.equal(result.checkedAt, '2026-11-07T04:45:00.000Z');
  assert.equal((await store.read()).payload.lastMutationId, 'market-refresh:2026-11-07');
  await assert.rejects(handler({ kind: 'market-refresh', jobKey: 'invalid', scheduledAt: new Date() }), /scheduled daily/);
});


test('retail MSRP, mismatched units, missing original posting or expired shop offers do not overwrite a previous quote', async () => {
  const badCases = [
    target => ({ ...sourcedBuyback(target, 7200), source: '公式定価', sourceStore: '公式定価' }),
    target => ({ ...sourcedBuyback(target), status: 'review' }),
    target => ({ ...sourcedBuyback(target), postUrl: '' }),
    target => ({ ...sourcedBuyback(target), unit: 'case' }),
    target => ({ ...sourcedBuyback(target), condition: 'なし' }),
    target => ({ ...sourcedBuyback(target), category: undefined }),
    target => ({ ...sourcedBuyback(target), productKey: undefined }),
    target => ({ ...sourcedBuyback(target), condition: undefined }),
    target => ({ ...sourcedBuyback(target), unit: undefined }),
    target => ({ ...sourcedBuyback(target), validUntil: '2026-11-06' }),
    target => ({ ...sourcedBuyback(target), source: '参考', sourceStore: '参考' })
  ];
  for (const build of badCases) {
    const store = memoryStore(sampleState());
    const result = await refreshMarketQuotes({
      store, mutationId: 'market-refresh:2026-11-07',
      runAt: '2026-11-07T04:45:00.000Z',
      provider: { async lookupMany(targets) { return [build(targets[0])]; } }
    });
    assert.equal(result.refreshedCount, 0);
    assert.equal(result.staleCount, 1);
    const quote = (await store.read()).payload.marketQuotes[0];
    assert.equal(quote.price, 1250);
    assert.equal(quote.fresh, false);
  }
});


test('new verified shop offer preserves another shop posting for future comparison', async () => {
  const state = sampleState();
  const target = { targetKey: marketTargetKey({ category: 'BOX', productKey: 'box-x', condition: 'あり' }),
    productKey: 'box-x', category: 'BOX', condition: 'あり' };
  state.marketQuotes = [{
    ...sourcedBuyback(target, 1200), priceBasis: 'buyback',
    lastCheckedAt: '2026-11-07T03:00:00.000Z', fresh: true
  }];
  const offer = {
    ...sourcedBuyback(target, 1300), source: 'トレカショップKURO',
    sourceStore: 'トレカショップKURO',
    postUrl: 'https://x.com/kuro_tcg/status/1234567890123456780'
  };
  const store = memoryStore(state);
  const result = await refreshMarketQuotes({
    store, mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany() { return [offer]; } }
  });
  assert.equal(result.refreshedCount, 1);
  const quotes = (await store.read()).payload.marketQuotes;
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].sourceStore, '買取ミミ');
  assert.equal(quotes[0].price, 1200);
  assert.equal(quotes[1].sourceStore, 'トレカショップKURO');
  assert.equal(quotes[1].price, 1300);
});


test('simultaneous verified buyback offers from three different shops remain independently available', async () => {
  const state = sampleState();
  state.marketQuotes = [];
  const store = memoryStore(state);
  const result = await refreshMarketQuotes({
    store, mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany(targets) {
      const target = targets[0];
      return [
        sourcedBuyback(target, 1300),
        { ...sourcedBuyback(target, 1450), source: 'カードショップアリウム',
          sourceStore: 'カードショップアリウム',
          postUrl: 'https://x.com/cardshop_allium/status/1234567890123456788' },
        { ...sourcedBuyback(target, 1400), source: 'トレカショップKURO',
          sourceStore: 'トレカショップKURO',
          postUrl: 'https://x.com/kuro_tcg/status/1234567890123456787' }
      ];
    } }
  });
  assert.equal(result.refreshedCount, 3);
  assert.equal(result.staleCount, 0);
  const quotes = (await store.read()).payload.marketQuotes;
  assert.equal(quotes.length, 3);
  assert.deepEqual(quotes.map(q => q.sourceStore).sort(),
    ['カードショップアリウム','トレカショップKURO','買取ミミ'].sort());
});

test('two conflicting offers from one shop are rejected without hiding another shop quote', async () => {
  const state = sampleState();
  state.marketQuotes = [];
  const store = memoryStore(state);
  const result = await refreshMarketQuotes({
    store, mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany(targets) {
      const mimi = sourcedBuyback(targets[0], 1500);
      return [
        mimi, { ...mimi, price: 1600 },
        { ...mimi, source: 'トレカショップKURO', sourceStore: 'トレカショップKURO',
          postUrl: 'https://x.com/kuro_tcg/status/1234567890123456787', price: 1450 }
      ];
    } }
  });
  assert.equal(result.refreshedCount, 1);
  assert.equal((await store.read()).payload.marketQuotes.length, 1);
  assert.equal((await store.read()).payload.marketQuotes[0].sourceStore, 'トレカショップKURO');
});

test('later same-shop price reduction is kept while old high quote becomes superseded', async () => {
  const state = sampleState();
  const target = { targetKey: marketTargetKey({ category: 'BOX', productKey: 'box-x', condition: 'あり' }),
    productKey: 'box-x', category: 'BOX', condition: 'あり' };
  state.marketQuotes = [{ ...sourcedBuyback(target, 2000),
    postedAt: '2026-11-07T01:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456701',
    status: 'verified', fresh: true }];
  const store = memoryStore(state);
  const reduction = { ...sourcedBuyback(target, 1500),
    postedAt: '2026-11-07T02:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456702' };
  await refreshMarketQuotes({
    store, mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany() { return [reduction]; } }
  });
  const quotes = (await store.read()).payload.marketQuotes;
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].status, 'superseded');
  assert.equal(quotes[0].price, 2000);
  assert.equal(quotes[1].status, 'verified');
  assert.equal(quotes[1].price, 1500);
});

test('old cached shop post cannot downgrade a newer already verified buyback amount', async () => {
  const state = sampleState();
  const target = { targetKey: marketTargetKey({ category: 'BOX', productKey: 'box-x', condition: 'あり' }),
    productKey: 'box-x', category: 'BOX', condition: 'あり' };
  state.marketQuotes = [{ ...sourcedBuyback(target, 1250),
    postedAt: '2026-11-07T03:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456703',
    status: 'verified', fresh: true }];
  const store = memoryStore(state);
  const staleOffer = { ...sourcedBuyback(target, 4000),
    postedAt: '2026-11-07T02:00:00Z',
    postUrl: 'https://x.com/mimi_kaitori/status/1234567890123456702' };
  const result = await refreshMarketQuotes({
    store, mutationId: 'market-refresh:2026-11-07',
    runAt: '2026-11-07T04:45:00.000Z',
    provider: { async lookupMany() { return [staleOffer]; } }
  });
  assert.equal(result.refreshedCount, 0);
  const quotes = (await store.read()).payload.marketQuotes;
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].price, 1250);
  assert.notEqual(quotes[0].price, 4000);
});
