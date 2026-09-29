import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';
const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const start=code.indexOf('function upsertApplication_('),end=code.indexOf('function sendReport_(',start);
const context=vm.createContext({});
vm.runInContext(code.slice(start,end),context);
const msg=(id='m1')=>({getId:()=>id,getFrom:()=>'noreply@livepocket.jp',getSubject:()=>'[LivePocket]抽選申込完了のお知らせ'});
test('LivePocket prefers exact ticket/product line over generic event name',()=>{
 const body=`イベント名：【古本市場久宝寺店】抽選販売（ポケモン拡張パック 30CELEBRATION）
会場：古本市場久宝寺店（大阪府）
販売受付名：抽選販売受付
申込番号：1052365305
【古本市場久宝寺店】 ポケカ抽選 販売（ストームエメラルダ）：¥0
当選発表予定日：2026/09/28(月) 〜 2026/09/30(水)`;
 const rows=[];const r=context.upsertApplication_(rows,body,msg(),new Date('2026-09-27T00:00:00Z'));
 assert.equal(r.kind,'created');
 assert.equal(rows[0].title,'ストームエメラルダ');
 assert.equal(rows[0].store,'古本市場久宝寺店');
});
test('LivePocket result metadata repairs an existing generic title',()=>{
 const item={title:'詳細不明',store:'古本市場三田店',updatedAt:''};
 const body=`イベント名：【古本市場三田店】ポケカ抽選販売（30th CELEBRATION プレミアムデッキセット)
会場：古本市場三田店（兵庫県）
チケット名：【古本市場三田店】ポケカ抽選販売（30th CELEBRATION プレミアムデッキセット ）
申込番号：1051878309`;
 const changed=context.applyLivePocketMetadata_(item,body,msg('m2'),new Date('2026-09-29T00:00:00Z'));
 assert.equal(changed,true);
 assert.equal(item.title,'30th CELEBRATION プレミアムデッキセット');
 assert.equal(item.store,'古本市場三田店');
});
