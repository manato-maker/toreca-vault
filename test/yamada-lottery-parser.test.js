import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';
const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const start=code.indexOf('function upsertApplication_('),end=code.indexOf('function sendReport_(',start);
const ctx=vm.createContext({TZ:'Asia/Tokyo',Utilities:{formatDate:()=> '2026'}});
vm.runInContext(code.slice(start,end),ctx);
const message={getId:()=>'1a0f093b388161d6',getFrom:()=>'ヤマダデンキ <noreply@ml.yamada-denki.jp>',getSubject:()=>'[ヤマダ]ご応募完了のお知らせ【ONE PIECEカードゲームカードセット 抽選販売】'};
test('Yamada application mail extracts exact product and pickup store',()=>{
 const body=`■ ご応募内容
＜お申込みキャンペーン名＞
ONE PIECEカードゲームカードセット 抽選販売

＜お申込み商品（※変更・再応募については下記注意事項をご確認ください）＞
ONE PIECEカードゲーム エクストラブースター ONE PIECE Heroines Edition vol.2【EB-05】 税込5,755円

＜受取希望店舗＞
テックランド香芝店`;
 const rows=[];const result=ctx.upsertApplication_(rows,body,message,new Date('2026-09-30T04:30:02Z'));
 assert.equal(result.kind,'created');
 assert.equal(rows[0].title,'ONE PIECEカードゲーム エクストラブースター ONE PIECE Heroines Edition vol.2【EB-05】');
 assert.equal(rows[0].store,'テックランド香芝店');
 assert.match(rows[0].id,/yamada-mail-1a0f093b388161d6/);
});
