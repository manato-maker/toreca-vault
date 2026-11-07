import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import { createMarketRefreshHandler, marketTargetKey, refreshMarketQuotes } from '../src/market-refresh-worker.js';

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
      return [{ targetKey: targets[0].targetKey, price: 1500, source: 'Verified shop' }];
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
  assert.equal(saved.payload.marketQuotes[0].price, 1500);
  assert.equal(saved.payload.marketQuotes[0].source, 'Verified shop');
  assert.equal(saved.payload.marketQuotes[0].quotedAt, '2026-11-07T04:45:00.000Z');
  assert.equal(saved.payload.marketQuotes[0].fresh, true);
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
      return [{ targetKey: targets[0].targetKey, price: 1600, source: 'Verified shop' }];
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
