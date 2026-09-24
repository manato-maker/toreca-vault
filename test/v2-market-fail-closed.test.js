import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../automation/V2Automation.gs', import.meta.url), 'utf8');
const state = {
  inventoryLots: [{ id: 'box-1', category: 'BOX', product: 'Example BOX', condition: 'シュリンクあり', quantity: 1 }],
  marketQuotes: [{ lotId: 'box-1', product: 'Example BOX', condition: 'シュリンクあり', price: 10000, fresh: true, trend: 'up', history: [{ date: '2026-09-23', value: 9000 }] }]
};
const context = vm.createContext({
  tv2Mutate_: (_kind, fn) => fn(state),
  normalize_: value => String(value || '').toLowerCase(),
  // Even a misleading aggregator result must never be consulted.
  UrlFetchApp: { fetch: () => { throw new Error('untrusted feed accessed'); } }
});
vm.runInContext(source.slice(0, source.indexOf('function tv2Mutate_(')), context);
const result = vm.runInContext('runTv2MarketAuto()', context);
assert.equal(result.report.updated, 0);
assert.equal(result.report.review, 1);
assert.equal(state.marketQuotes[0].price, 10000);
assert.equal(state.marketQuotes[0].fresh, false);
assert.equal(state.marketQuotes[0].trend, 'stale');
assert.equal(state.marketQuotes[0].history.length, 1);
assert.equal(state.automation.health.marketStatus, 'review');
assert.ok(state.automation.health.lastMarketRunAt);

// An old lot-linked quote with a different condition must not be touched.
const other = { lotId: 'box-1', product: 'Example BOX', condition: 'シュリンクなし', price: 8000, fresh: true, trend: 'same' };
state.marketQuotes = [other];
vm.runInContext('runTv2MarketAuto()', context);
assert.equal(other.fresh, true);
assert.equal(other.price, 8000);
