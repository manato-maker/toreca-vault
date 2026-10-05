import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('ledger explains monthly totals and cost basis',()=>{
  assert.match(source,/当月購入額/);
  assert.match(source,/当月売却額/);
  assert.match(source,/原価未確定 .*損益・回収率から除外/);
  assert.match(source,/売却 .* ÷ 原価/);
});

test('sale rows display distinguishable condition and cost status',()=>{
  assert.match(source,/function transactionConditionText/);
  assert.match(source,/シュリンクあり/);
  assert.match(source,/シュリンクなし/);
  assert.match(source,/function saleCostStatusText/);
  assert.match(source,/transaction-condition/);
});
