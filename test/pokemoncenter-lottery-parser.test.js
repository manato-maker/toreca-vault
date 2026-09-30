import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';

const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const start=code.indexOf('function upsertApplication_('),end=code.indexOf('function sendReport_(',start);
const ctx=vm.createContext({TZ:'Asia/Tokyo',Utilities:{formatDate:()=> '2026'}});
vm.runInContext(code.slice(start,end),ctx);
const message=(id,subject)=>({getId:()=>id,getFrom:()=>'ポケモンセンターオンライン <info@pokemoncenter-online.com>',getSubject:()=>subject});

test('Pokemon Center application mail creates a stable product-code lottery entry',()=>{
 const body=`ポケモンセンターオンラインをご利用いただきありがとうございます。
【申込日】 2026年09月11日（金）20時47分
【件名】
【プレイヤーズクラブ：本人認証済み枠】【抽選販売】ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX
【商品情報】
9900000008284 ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX 7,200円（1個）
【抽選結果発表】 2026年09月30日（水）13時00分 以降予定`;
 const rows=[];
 const result=ctx.upsertApplication_(rows,body,message('app1','[ポケモンセンターオンライン]応募完了のお知らせ'),new Date('2026-09-11T11:47:00Z'));
 assert.equal(result.kind,'created');
 assert.equal(rows[0].id,'lottery-livepocket-pokemoncenter-9900000008284');
 assert.equal(rows[0].title,'30th CELEBRATION BOX');
 assert.equal(rows[0].store,'ポケモンセンターオンライン');
 assert.equal(rows[0].resultDate,'2026-09-30');
});

test('Pokemon Center title parser distinguishes FUTURISTIC BOX',()=>{
 const body=`【商品情報】
4521329463872 ポケモンカードゲーム MEGA 30th CELEBRATION FUTURISTIC BOX 27,500円（1個）`;
 assert.equal(ctx.extractPokemonCenterProductCode_(body),'4521329463872');
 assert.equal(ctx.extractPokemonCenterTitle_(body),'30th CELEBRATION FUTURISTIC BOX');
});

test('Pokemon Center result parser extracts order deadline',()=>{
 const body=`【抽選結果】 当選
【商品情報】
9900000008284 ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX 7,200円（1個）
注文期間：2026年09月30日(水) 13時00分～2026年10月06日(火) 16時59分`;
 ctx.Utilities={formatDate:()=> '2026-09-30'};
 const parsed=ctx.parseResult_(body,new Date('2026-09-30T04:00:00Z'));
 assert.equal(parsed.status,'当選');
 assert.equal(parsed.receiveDeadline,'2026-10-06');
});
