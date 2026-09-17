import test from'node:test';import assert from'node:assert/strict';import{transactionKind,transactionAmount,transactionBreakdown,marketCheckedDate}from'../js/presentation.js';

test('購入と売却を表示種別に分ける',()=>{assert.equal(transactionKind('purchases'),'purchase');assert.equal(transactionKind('sales'),'sale')});
test('2BOXは合計と単価×数量を自動生成する',()=>{const x={category:'BOX',price:16600,quantity:2};assert.equal(transactionAmount(x),33200);assert.deepEqual(transactionBreakdown(x),{quantity:2,unit:16600,total:33200,unitLabel:'BOX',showBreakdown:true,text:'¥16,600 × 2BOX'})});
test('次回登録でも数量から合計を計算し固定値を持たない',()=>{const x={category:'BOX',price:7200,quantity:3};assert.equal(transactionBreakdown(x).total,21600);assert.equal(transactionBreakdown(x).text,'¥7,200 × 3BOX')});
test('1点なら内訳の強調表示は不要',()=>{assert.equal(transactionBreakdown({category:'カード',price:8980,quantity:1}).showBreakdown,false)});
test('カード相場取得日は日時から日付だけ表示できる',()=>{assert.equal(marketCheckedDate({marketCheckedAt:'2026-09-17T12:54:00+09:00'}),'2026-09-17');assert.equal(marketCheckedDate({}),'')});
