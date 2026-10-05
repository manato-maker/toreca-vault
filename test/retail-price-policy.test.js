import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {retailPriceInfo} from '../v2/retail-price.js';
import {v2EntryPayload} from '../v2/ui-entry.js';

test('official MSRP catalog resolves current sealed products',()=>{
 assert.equal(retailPriceInfo('ストームエメラルダ','BOX').price,6000);
 assert.equal(retailPriceInfo('インフェルノX','BOX').price,5400);
 assert.equal(retailPriceInfo('30th CELEBRATION','BOX').price,7200);
 assert.equal(retailPriceInfo('30th CELEBRATION カードセット（9種セット）','BOX').price,10800);
 assert.equal(retailPriceInfo('30th CELEBRATION FUTURISTIC BOX','BOX').price,27500);
 assert.equal(retailPriceInfo('ドラゴンボール BRIGHTNESS OF HOPE','BOX').price,5760);
 assert.equal(retailPriceInfo('MEGAドリームex','BOX').price,5500);
 assert.equal(retailPriceInfo('ブラックボルト','BOX').price,5800);
 assert.equal(retailPriceInfo('スタートデッキ100 バトルコレクション','その他').price,891);
 assert.equal(retailPriceInfo('スペシャルBOX ポケモンセンターフクオカ','その他').price,2090);
 assert.equal(retailPriceInfo('世界最強の戦士 OP-17（テープカット4BOX分）','その他',1).price,23040);
});

test('manual sealed purchase accounting ignores discounted entered price',()=>{
 const x=v2EntryPayload('purchases',{product:'ストームエメラルダ',category:'BOX',condition:'あり',inventoryAction:'在庫へ追加',quantity:1,price:5100});
 assert.equal(x.price,6000);assert.equal(x.total,6000);assert.equal(x.actualPaid,5100);assert.equal(x.priceBasis,'希望小売価格');
});

test('single card purchase keeps actual entered price',()=>{
 const x=v2EntryPayload('purchases',{product:'ニンフィアV',category:'カード',condition:'美品',inventoryAction:'在庫へ追加',quantity:1,price:8000});
 assert.equal(Number(x.price),8000);assert.equal(x.priceBasis,undefined);
});

test('unknown sealed product fails closed instead of using discount price',()=>{
 assert.throws(()=>v2EntryPayload('purchases',{product:'未登録BOX',category:'BOX',condition:'あり',inventoryAction:'在庫へ追加',quantity:1,price:1}),/定価未登録/);
});

test('Apps Script has canonical MSRP backfill and sale cost basis',()=>{
 const source=fs.readFileSync(new URL('../automation/RetailPricePolicy.gs',import.meta.url),'utf8');
 assert.match(source,/TV2_RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v2'/);
 assert.match(source,/acquisitionCostBasis='希望小売価格'/);
});
