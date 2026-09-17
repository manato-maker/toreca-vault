import test from'node:test';
import assert from'node:assert/strict';
import{franchiseOf,FRANCHISES}from'../js/franchise.js';

test('作品区分は3区分',()=>assert.deepEqual(FRANCHISES,['ポケモン','ワンピース','その他']));
test('ポケモンを自動判定',()=>{assert.equal(franchiseOf({product:'MEGA 拡張パック 30th CELEBRATION'}),'ポケモン');assert.equal(franchiseOf({product:'MEGA スタートデッキ100'}),'ポケモン')});
test('ワンピースを自動判定',()=>assert.equal(franchiseOf({product:'世界最強の戦士 OP-17（テープ付き）'}),'ワンピース'));
test('ドラゴンボールとユニオンアリーナはその他',()=>{assert.equal(franchiseOf({product:'ドラゴンボール フュージョンワールド'}),'その他');assert.equal(franchiseOf({product:'ユニオンアリーナ ブースターパック'}),'その他')});
test('明示区分を優先',()=>assert.equal(franchiseOf({product:'不明商品',franchise:'ワンピース'}),'ワンピース'));
