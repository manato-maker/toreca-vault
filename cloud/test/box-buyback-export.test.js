import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBoxCondition, buildBoxBuybackExport, formatBoxBuybackExport
} from '../src/box-buyback-export.js';
import { exportCurrentBoxes } from '../scripts/export-box-buyback-staging.js';

function lot(product,quantity,condition,category='BOX') {
  return {id:Math.random().toString(36),product,productKey:product,
    category,condition,quantity,unitCost:8000,store:'SECRET PRIVATE STORE',
    requestId:'SECRET_REQUEST',memo:'SECRET MEMO'};
}
function canonical(lots) {
  return {revision:2971,payload:{revision:2971,inventoryLots:lots,
    transactions:[{id:'secret-transaction',type:'sale'}]}};
}
test('known shrink and intact-tape states are eligible for price matching',()=>{
  const cases=[
    ['シュリンクあり','シュリンクあり'],
    ['シュリンク付き','シュリンクあり'],
    ['シュリンク無し','シュリンクなし'],
    ['シュリンクなし','シュリンクなし'],
    ['テープ未カット','テープ未カット'],
    ['テープ未切断','テープ未カット']
  ];
  for(const [value,label] of cases) {
    const x=classifyBoxCondition(value);
    assert.equal(x.group,'target');
    assert.equal(x.label,label);
  }
});
test('opened and tape-cut boxes are excluded, unknown and contradictory are not guessed',()=>{
  for(const condition of ['開封済み','開封用','テープカット','シュリンクなし パックのみ','バラパック']) {
    assert.equal(classifyBoxCondition(condition).group,'excluded');
  }
  for(const condition of ['', '未開封', 'テープ付き', 'テープなし', 'シュリンクあり シュリンクなし']) {
    assert.equal(classifyBoxCondition(condition).group,'review');
  }
});
test('only current positive quantity BOX lots, not purchases, sales, packs or cards',()=>{
  const state=canonical([
    lot('ポケモン 30th CELEBRATION',2,'シュリンク付き'),
    lot('ポケモン 30th CELEBRATION',1,'シュリンクあり'),
    lot('ポケモン 30th CELEBRATION',1,'シュリンクなし'),
    lot('神の支配 OP-18',2,'テープ未カット'),
    lot('神の支配 OP-18',1,'テープカット'),
    lot('未確認のBOX',1,''),
    lot('神の支配 OP-18',4,'テープ未カット','パック'),
    lot('高額カード',5,'シュリンクあり','カード'),
    lot('売却済みBOX',0,'シュリンクあり')
  ]);
  const original=structuredClone(state);
  const v=buildBoxBuybackExport(state);
  assert.equal(v.revision,2971);
  assert.equal(v.target.length,3);
  assert.equal(v.target.find(x=>x.product==='ポケモン 30th CELEBRATION'&&x.label==='シュリンクあり').quantity,3);
  assert.equal(v.target.find(x=>x.product==='ポケモン 30th CELEBRATION'&&x.label==='シュリンクなし').quantity,1);
  assert.equal(v.target.find(x=>x.product==='神の支配 OP-18').quantity,2);
  assert.equal(v.review.length,1);
  assert.equal(v.excluded.length,1);
  assert.deepEqual(state,original);
  const text=formatBoxBuybackExport(v,new Date('2026-11-23T04:00:00Z'));
  assert.match(text,/13:00/);
  assert.match(text,/ポケモン 30th CELEBRATION｜3BOX｜シュリンクあり/);
  assert.match(text,/神の支配 OP-18｜2BOX｜テープ未カット/);
  assert.doesNotMatch(text,/SECRET PRIVATE|SECRET_REQUEST|SECRET MEMO|高額カード|売却済みBOX/);
});
test('mixed or invalid quantity and malformed canonical block without export',()=>{
  for(const bad of [
    {quantity:-1}, {quantity:1.5}, {quantity:NaN}, {quantity:'2'}
  ]) {
    const x=lot('BOX',2,'シュリンクあり');x.quantity=bad.quantity;
    assert.throws(()=>buildBoxBuybackExport(canonical([x])),/quantity/);
  }
  const x=canonical([lot('BOX',1,'シュリンクあり')]);x.revision=2972;
  assert.throws(()=>buildBoxBuybackExport(x),/canonical snapshot/);
});
test('local export is only a private text file; no Firestore or Sheets writes',async()=>{
  let writes=0;
  const x=canonical([lot('神の支配 OP-18',1,'テープ未カット')]);
  const options=[];
  const output=[];
  const store={read:async()=>structuredClone(x),save:async()=>{writes++}};
  const result=await exportCurrentBoxes({
    store, destination:'/example/test.txt',
    write:(p,s,o)=>options.push({path:p,text:s,options:o}),
    chmod:(p,m)=>options.push({path:p,chmod:m}),
    display:v=>output.push(v),
    now:new Date('2026-11-23T04:00:00Z')
  });
  assert.equal(writes,0);
  assert.equal(result.targetCount,1);
  assert.equal(options[0].options.mode,0o600);
  assert.equal(options[1].chmod,0o600);
  assert.match(result.text,/神の支配 OP-18/);
  assert.match(output.join('\n'),/no cloud writes/);
});
