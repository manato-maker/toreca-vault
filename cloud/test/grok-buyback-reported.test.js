import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyV2 } from '../../v2/core.js';
import { renderDashboard } from '../src/dashboard-view.js';
import {
  previewGrokReportedPrices, grokReportedOffersForLot
} from '../src/grok-buyback-reported.js';
import { applyGrokReportedPrices } from '../scripts/apply-grok-prices-staging.js';

const date=new Date('2026-04-01T06:00:00Z');
const privateInput={
  reportDate:'2026-04-01',
  stockSpec:'d=2a;i=1a;s=2u;t=1u;f=1u;e=1u',
  priceSpec:'d=100,0,50;i=200,180r,190;s=0,30,40;t=50,40,0;f=80,70,0;e=90,60,0'
};
const names=[
  ['MEGAドリームex',2], ['インフェルノX',1],
  ['MEGA スタートデッキ100 バトルコレクション',1],
  ['ポケモンカードゲーム MEGA スタートデッキ100 バトルコレクション',1],
  ['スペシャルBOX ポケモンセンタートウホク',1],
  ['スペシャルBOX ポケモンセンターフクオカ',1],
  ['ポケモンカードゲーム MEGA 30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー',1]
];
function state() {
  const s=emptyV2();s.revision=2971;
  s.inventoryLots=names.map(([name,quantity],i)=>({
    id:'lot-'+i,product:name,productKey:name,category:'BOX',condition:'',
    quantity,unitCost:5600,store:'PRIVATE SHOP',requestId:'SENSITIVE',memo:'PRIVATE'
  }));
  s.transactions.push({id:'original-purchase',type:'purchase'});
  return s;
}
function storeFor(initial=state()) {
  let current=structuredClone(initial),writes=0;
  return {
    get writes(){return writes;},
    async read(){return {revision:current.revision,payload:structuredClone(current)};},
    async save({expectedRevision,mutationId,payload}){
      assert.equal(expectedRevision,current.revision);
      assert.equal(payload.lastMutationId,mutationId);
      current=structuredClone(payload);writes++;
    }
  };
}
test('all seven reported boxes and six product families are strict matching and no verified quotes are forged',()=>{
  const s=state(), before=structuredClone(s);
  const r=previewGrokReportedPrices(s,privateInput);
  assert.equal(r.changed,7);
  assert.equal(r.added,15);
  assert.equal(r.priceTotalYen,700);
  assert.equal(r.state.marketQuotes.filter(q=>q.status==='verified').length,0);
  assert.equal(r.state.marketQuotes.filter(q=>q.evidenceVerified===false && q.status==='review').length,15);
  assert.equal(r.state.marketQuotes.filter(q=>q.postUrl==='').length,15);
  assert.equal(r.state.inventoryLots.filter(l=>l.condition==='あり').length,2);
  assert.equal(r.state.inventoryLots.filter(l=>l.condition==='未開封').length,5);
  assert.deepEqual(s,before);
  assert.deepEqual(r.state.transactions,s.transactions);
  for(let i=0;i<7;i++) {
    assert.equal(r.state.inventoryLots[i].unitCost,s.inventoryLots[i].unitCost);
    assert.equal(r.state.inventoryLots[i].quantity,s.inventoryLots[i].quantity);
    assert.equal(r.state.inventoryLots[i].store,s.inventoryLots[i].store);
  }
  const html=renderDashboard(r.state,r.state.revision,'2026-11',date);
  assert.match(html,/Grok報告参考額/);
  assert.match(html,/700/);
  assert.match(html,/Grok報告（元投稿未検証）/);
  assert.match(html,/100/);
  assert.match(html,/200/);
  assert.match(html,/参考買取評価額/);
  assert.match(html,/参考買取評価額<\/div><strong>[¥￥]700<\/strong>/);
  assert.match(html,/出典確認済み買取額<\/div><strong>未取得<\/strong>/);
  assert.doesNotMatch(html,/確認済み評価としてGrok/);
});
test('the batch is idempotent and blocks any quantity mismatch or contradictory condition',()=>{
  const applied=previewGrokReportedPrices(state(),privateInput);
  const again=previewGrokReportedPrices(applied.state,privateInput);
  assert.equal(again.idempotent,true);
  assert.equal(again.added,0);
  const missing=state();missing.inventoryLots[2].quantity=2;
  assert.throws(()=>previewGrokReportedPrices(missing,privateInput),/BOX count differs/);
  const absent=state();absent.inventoryLots.splice(6,1);
  assert.throws(()=>previewGrokReportedPrices(absent,privateInput),/BOX count differs/);
  const contradict=state();contradict.inventoryLots[0].condition='シュリンクなし';
  assert.throws(()=>previewGrokReportedPrices(contradict,privateInput),/shrink condition conflicts/);
  const noShrink=state();noShrink.inventoryLots[4].condition='シュリンクなし';
  const unchanged=previewGrokReportedPrices(noShrink,privateInput).state;
  assert.equal(unchanged.inventoryLots[4].condition,'シュリンクなし');
  // Legacy "not applicable" refers to shrink packaging for non-booster
  // sealed goods, not a confirmed opening; owner attested unopened status.
  const legacy=state();
  for(const i of [2,3,4,5,6])legacy.inventoryLots[i].condition='対象外';
  const reconciled=previewGrokReportedPrices(legacy,privateInput);
  assert.equal(reconciled.state.inventoryLots.filter(x=>x.condition==='未開封').length,5);
  assert.equal(reconciled.state.inventoryLots.filter(x=>x.condition==='あり').length,2);
  assert.equal(reconciled.state.marketQuotes.length,15);
  const legacyShrink=state();legacyShrink.inventoryLots[0].condition='対象外';
  assert.throws(()=>previewGrokReportedPrices(legacyShrink,privateInput),/shrink condition conflicts/);
  const carton=state();carton.inventoryLots[2].product='MEGA スタートデッキ100 バトルコレクション 白箱';
  assert.throws(()=>previewGrokReportedPrices(carton,privateInput),/BOX count differs/);
});
test('review price disappears after seven days, never becomes current verified price',()=>{
  const r=previewGrokReportedPrices(state(),privateInput);
  const lot=r.state.inventoryLots[0];
  assert.equal(grokReportedOffersForLot(r.state.marketQuotes,lot,date).length,2);
  assert.equal(grokReportedOffersForLot(r.state.marketQuotes,lot,new Date('2026-04-10T06:00:00Z')).length,0);
});
test('inspect is read only; applying makes private backup and only revisioned state save',async()=>{
  const store=storeFor(),logs=[],saved=[];
  const inspect=await applyGrokReportedPrices({store,privateInput,mode:'inspect',display:x=>logs.push(x),
    write:()=>{throw Error('inspect must not write')}});
  assert.equal(inspect.applied,false);assert.equal(store.writes,0);
  const updated=await applyGrokReportedPrices({store,privateInput,mode:'apply',home:'/backup',
    write:(path,content,opts)=>saved.push({path,content,opts}),
    display:x=>logs.push(x)});
  assert.equal(updated.applied,true);
  assert.equal(store.writes,1);
  assert.equal(updated.revisionAfter,2972);
  assert.equal(saved.length,1);
  assert.match(saved[0].path,/toreca-staging-before-grok-rev2971/);
  assert.equal(saved[0].opts.mode,0o600);
  assert.equal(saved[0].opts.flag,'wx');
  const repeat=await applyGrokReportedPrices({store,privateInput,mode:'apply',write:()=>{throw Error('duplicate wrote backup')},
    display:x=>logs.push(x)});
  assert.equal(repeat.reportAlreadyApplied,true);assert.equal(store.writes,1);
  assert.match(logs.join(' '),/readback verified/);
});

test('a failed first CAS may retry after verifying identical private prewrite backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'grok-import-backup-'));
  try {
    const backing=storeFor();
    let failFirst=true;
    const store={
      read:()=>backing.read(),
      async save(args){
        if(failFirst){failFirst=false;throw Object.assign(new Error('temporary failure'),{code:'UNAVAILABLE'});}
        return backing.save(args);
      }
    };
    await assert.rejects(
      applyGrokReportedPrices({store,privateInput,mode:'apply',home:dir,display:()=>{}}),
      /temporary failure/
    );
    assert.equal(backing.writes,0);
    const path=join(dir,'toreca-staging-before-grok-rev2971-'+privateInput.reportDate+'.json');
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),state());
    const log=[];
    const done=await applyGrokReportedPrices({store,privateInput,mode:'apply',home:dir,display:x=>log.push(x)});
    assert.equal(done.applied,true);
    assert.equal(backing.writes,1);
    assert.match(log.join('\n'),/reusing it/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('mobile inventory groups categories and prioritizes Grok provisional reference over a stale legacy 42k',()=>{
  const imported=previewGrokReportedPrices(state(),privateInput).state;
  imported.inventoryLots.push(
    {id:'pack-extra',product:'テストパック',productKey:'テストパック',category:'パック',condition:'',
      quantity:3,unitCost:200,acquiredAt:'2026-04-01'},
    {id:'card-extra',product:'テストカード',productKey:'テストカード',category:'カード',condition:'',
      quantity:1,unitCost:300,acquiredAt:'2026-04-01'}
  );
  const retailLot=imported.inventoryLots.find(l=>l.product==='MEGA スタートデッキ100 バトルコレクション');
  imported.marketQuotes.push({
    lotId:retailLot.id,productKey:retailLot.productKey,category:'BOX',condition:retailLot.condition,
    unit:'box',productIdentity:'starter-deck-100-retail-single',price:42000,buybackYen:42000,
    sourceStore:'買取ミミ',source:'X',status:'verified',
    postedAt:'2026-03-01T10:00:00+09:00',postUrl:'https://x.com/mimi_kaitori/status/123456789'
  });
  const html=renderDashboard(imported,imported.revision,'2026-04',date);
  assert.match(html, /href="#stock-box"/);
  assert.match(html, /href="#stock-pack"/);
  assert.match(html, /href="#stock-card"/);
  assert.match(html, /id="stock-box"/);
  assert.match(html, /id="stock-pack"/);
  assert.match(html, /id="stock-card"/);
  assert.match(html, /BOX 8点/);
  assert.match(html, /パック 3点/);
  assert.match(html, /カード 1点/);
  assert.match(html, /参考買取評価額<\/div><strong>[¥￥]700<\/strong>/);
  assert.match(html, /出典確認済み買取額<\/div><strong>未取得<\/strong>/);
  assert.match(html, /Grok参考・未検証/);
  assert.match(html, /カードショップアリウム/);
  assert.match(html, /AMTAF日本橋/);
  assert.doesNotMatch(html, /42,000/);
  assert.doesNotMatch(html, /旧価格/);
  const expired=renderDashboard(imported,imported.revision,'2026-04',new Date('2026-04-10T06:00:00Z'));
  assert.doesNotMatch(expired, /42,000/);
  assert.doesNotMatch(expired, /Grok参考・未検証/);
  assert.match(expired, /買取相場未取得/);
});
