import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';
const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const start=code.indexOf('function upsertApplication_('),end=code.indexOf('function sendReport_(',start);
const context=vm.createContext({Utilities:{formatDate:()=> '2026'},TZ:'Asia/Tokyo'});
vm.runInContext(code.slice(start,end),context);
const msg=(id='m1')=>({getId:()=>id,getFrom:()=>'noreply@livepocket.jp',getSubject:()=>'[LivePocket]抽選申込完了のお知らせ'});

test('Yellow Submarine LivePocket application imports announced result date',()=>{
 const body=`イベント名：落選者専用：10月再販ポケモンカードゲーム「30th CELEBRATION」購入権抽選
会場：イエローサブマリン（その他）
販売受付名：落選者専用　10月再販：30th CELEBRATION購入権抽選受付
申込番号：1054301100
落選者専用：10月再販「30th CELEBRATION」購入権：¥0
当選発表予定日：10月10日`;
 const rows=[];const r=context.upsertApplication_(rows,body,msg('ys'),new Date('2026-10-04T00:00:00Z'));
 assert.equal(r.kind,'created');assert.equal(rows[0].resultDate,'2026-10-10');assert.match(rows[0].title,/30th CELEBRATION/);assert.equal(rows[0].store,'イエローサブマリン');
});

test('LivePocket application backfills result date on an existing application number',()=>{
 const body=`イベント名：落選者専用：10月再販ポケモンカードゲーム「30th CELEBRATION」購入権抽選
会場：イエローサブマリン（その他）
申込番号：1054301100
落選者専用：10月再販「30th CELEBRATION」購入権：¥0
当選発表予定日：10月10日`;
 const rows=[{id:'lottery-livepocket-1054301100',title:'30th CELEBRATION',store:'イエローサブマリン',status:'応募済',resultDate:'',memo:'自動登録｜申込番号 1054301100'}];
 const r=context.upsertApplication_(rows,body,msg('ys2'),new Date('2026-10-04T00:00:00Z'));
 assert.equal(r.kind,'updated');assert.equal(rows[0].resultDate,'2026-10-10');
});

test('Hobby Station LivePocket uses selected shop ticket as store, not as product',()=>{
 const body=`イベント名：ホビーステーション「ポケモンカードゲームMEGA 拡張パック 30th CELEBRATION（再販）」抽選販売
会場：ホビーステーション（全国各地）
販売受付名：「30th CELEBRATION再販）」抽選受付（関東以外）
申込番号：1053491691
日本橋2's店：¥0
当選発表予定日：2026年10月9日(金)`;
 const rows=[];const r=context.upsertApplication_(rows,body,msg('hs'),new Date('2026-10-02T00:00:00Z'));
 assert.equal(r.kind,'created');assert.equal(rows[0].resultDate,'2026-10-09');assert.equal(rows[0].store,"日本橋2's店");assert.match(rows[0].title,/30th CELEBRATION/);
});

test('scheduled Gmail query always includes LivePocket sender and parser upgrade replays 30 days',()=>{
 const src=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
 assert.match(src,/gmail-efficient-v8-livepocket-complete/);
 assert.match(src,/parserChanged\?new Date\(now\.getTime\(\)-30\*86400000\)/);
 assert.match(src,/after\+' \{from:noreply@livepocket\.jp 抽選 当選 落選 応募 申込\}'/);
});
