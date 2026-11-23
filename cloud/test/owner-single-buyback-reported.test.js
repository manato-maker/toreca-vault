import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyV2} from '../../v2/core.js';
import {renderDashboard} from '../src/dashboard-view.js';
import {parseOwnerSinglePrices,previewOwnerSinglePrices,ownerSingleReportedOffersForLot} from '../src/owner-single-buyback-reported.js';
import {applyOwnerSinglePrices,inspectOwnerSinglePersistence,classifyFirestoreError} from '../scripts/staging-owner-single-buyback.js';
const privateInput={
  reportDate:'2026-04-03',expectedLots:3,expectedCards:4,
  priceSpec:'AA_001/100=1,200,20260403,f;BB_002/100=2,450,20260402,k,m'
};
function sample(){
  const s=emptyV2();s.revision=45;
  s.inventoryLots=[
    {id:'card-a',product:'テストカードA',productKey:'テストカードA',category:'カード',set:'AA 001/100',condition:'良品',quantity:1,unitCost:0},
    {id:'card-b',product:'テストカードB',productKey:'テストカードB',category:'カード',set:'BB 002/100',condition:'良品',quantity:2,unitCost:0},
    {id:'card-held',product:'テストカードC',productKey:'テストカードC',category:'カード',set:'CC 003/100',condition:'良品',quantity:1,unitCost:0}
  ];
  s.transactions.push({id:'original-tx',type:'purchase',price:400});
  return s;
}
function fakeStore(original=sample()){
  let state=structuredClone(original),writes=0;
  return {
    get writes(){return writes;},
    async read(){return {revision:state.revision,payload:structuredClone(state)};},
    async save({expectedRevision,mutationId,payload}){
      assert.equal(expectedRevision,state.revision);
      assert.equal(payload.lastMutationId,mutationId);
      state=structuredClone(payload);writes++;
    }
  };
}
test('provisional owner singles import is strict by registered card set and does not touch inventory/cost/sales',()=>{
  const original=sample();
  const parsed=parseOwnerSinglePrices(privateInput);
  assert.equal(parsed.items.size,2);
  const result=previewOwnerSinglePrices(original,privateInput);
  assert.equal(result.changed,2);
  assert.equal(result.pricedCards,3);
  assert.equal(result.unpricedCards,1);
  assert.equal(result.reportedTotalYen,1100);
  assert.equal(result.state.revision,46);
  assert.equal(result.state.marketQuotes.length,2);
  assert.deepEqual(result.state.inventoryLots,original.inventoryLots);
  assert.deepEqual(result.state.transactions,original.transactions);
  assert.deepEqual(result.state.lotteries,original.lotteries);
  assert.equal(result.state.marketQuotes[1].claimedFinish,'マスターボールミラー');
  assert.equal(result.state.marketQuotes[0].status,'review');
  assert.equal(result.state.marketQuotes[0].evidenceVerified,false);
  assert.equal(result.state.marketQuotes[0].postUrl,'');
  const now=new Date('2026-04-04T03:00:00Z');
  assert.equal(ownerSingleReportedOffersForLot(result.state.marketQuotes,result.state.inventoryLots[0],now).length,1);
  assert.equal(ownerSingleReportedOffersForLot(result.state.marketQuotes,result.state.inventoryLots[2],now).length,0);
  const html=renderDashboard(result.state,46,'2026-04',now);
  assert.match(html,/カード調査参考額/);
  assert.match(html,/カード調査参考・未検証/);
  assert.match(html,/カード調査（元掲載未検証）/);
  assert.match(html,/マスターボールミラー|カードラッシュ参照/);
  assert.match(html,/参考買取評価額<\/div><strong>[¥￥]1,100<\/strong>/);
  assert.match(html,/出典確認済み買取額<\/div><strong>未取得<\/strong>/);
  assert.match(html,/相場未取得<\/div><strong>1点<\/strong>/);
  const old=renderDashboard(result.state,46,'2026-04',new Date('2026-04-12T03:00:00Z'));
  assert.doesNotMatch(old,/カード調査参考・未検証/);
  assert.match(old,/買取相場未取得/);
});
test('idempotent import; mismatched quantity, edition or dates fail closed',()=>{
  const first=previewOwnerSinglePrices(sample(),privateInput);
  assert.equal(previewOwnerSinglePrices(first.state,privateInput).alreadyApplied,true);
  const broken=sample();broken.inventoryLots[1].quantity=3;
  assert.throws(()=>previewOwnerSinglePrices(broken,privateInput),/inventory counts changed/);
  const wrongSet=sample();wrongSet.inventoryLots[1].set='ZZ 999/100';
  assert.throws(()=>previewOwnerSinglePrices(wrongSet,privateInput),/card identity BB 002\/100 is not fully recorded/);
  const dup=sample();dup.inventoryLots[2].set='BB 002/100';
  assert.throws(()=>previewOwnerSinglePrices(dup,privateInput),/two card lots share/);
  const identityReview=sample();identityReview.inventoryLots[1].identityNeedsReview=true;
  assert.throws(()=>previewOwnerSinglePrices(identityReview,privateInput),/identity review/);
  assert.throws(()=>previewOwnerSinglePrices(sample(),{...privateInput,
    priceSpec:'AA_001/100=1,200,20260301,f'}),/expired/);
  assert.throws(()=>previewOwnerSinglePrices(sample(),{...privateInput,
    priceSpec:'AA_001/100=1,200,20260405,f'}),/future/);
});
test('inspect writes nothing; apply safeguards private backup, CAS and verifies idempotence',async()=>{
  const home=mkdtempSync(join(tmpdir(),'single-report-'));
  try{
    const store=fakeStore();
    const outputs=[];
    const inspect=await applyOwnerSinglePrices({store,privateInput,mode:'inspect',home,out:x=>outputs.push(x)});
    assert.equal(inspect.applied,false);
    assert.equal(store.writes,0);
    const update=await applyOwnerSinglePrices({store,privateInput,mode:'apply',home,out:x=>outputs.push(x)});
    assert.equal(update.applied,true);
    assert.equal(store.writes,1);
    assert.equal(update.revision,46);
    const snapshot=JSON.parse(readFileSync(join(home,'toreca-staging-before-owner-singles-rev45.json'),'utf8'));
    assert.deepEqual(snapshot,sample());
    const retry=await applyOwnerSinglePrices({store,privateInput,mode:'apply',home,out:x=>outputs.push(x)});
    assert.equal(retry.alreadyApplied,true);
    assert.equal(store.writes,1);
    assert.match(outputs.join('\n'),/saved to staging canonical/);
    assert.match(outputs.join('\n'),/purchases, sales and lotteries unchanged/);
  }finally{rmSync(home,{force:true,recursive:true});}
});

test('legacy inventory number-only set plus matching expansion in product resolves without guessing',()=>{
  const original=sample();
  const last=original.inventoryLots[2];
  last.set='003/100';
  last.product='テストカードC CC 003/100';
  last.productKey=last.product;
  const input={...privateInput,
    priceSpec:privateInput.priceSpec+';CC_003/100=1,120,20260403,k'};
  const result=previewOwnerSinglePrices(original,input);
  assert.equal(result.changed,3);
  assert.equal(result.pricedCards,4);
  assert.equal(result.reportedTotalYen,1220);
  assert.equal(result.unpricedCards,0);
  assert.deepEqual(result.state.inventoryLots,original.inventoryLots);
});
test('bare number and foil descriptor without registered expansion cannot be priced as a guessed edition',()=>{
  const original=sample();
  original.inventoryLots[2].set='003/100';
  original.inventoryLots[2].product='テストカードC（金色・特殊仕様）';
  const input={...privateInput,
    priceSpec:privateInput.priceSpec+';CC_003/100=1,120,20260403,k'};
  assert.throws(()=>previewOwnerSinglePrices(original,input),
    /card identity CC 003\/100 is not fully recorded/);
});
test('contradictory legacy number and product identity fail closed before CAS',()=>{
  const original=sample();
  original.inventoryLots[2].set='004/100';
  original.inventoryLots[2].product='テストカードC CC 003/100';
  const input={...privateInput,
    priceSpec:privateInput.priceSpec+';CC_003/100=1,120,20260403,k'};
  assert.throws(()=>previewOwnerSinglePrices(original,input),
    /card number contradicts explicit expansion identity/);
});

test('read-only status reports no owner quotes after failed Firestore write',async()=>{
  const store=fakeStore(),logs=[];
  const result=await inspectOwnerSinglePersistence({store,out:x=>logs.push(x)});
  assert.equal(result.quotes,0);
  assert.equal(result.audits,0);
  assert.equal(result.revision,45);
  assert.equal(store.writes,0);
  assert.match(logs.join('\n'),/READ ONLY/);
});
test('read-only status recognizes a completed previous write without adding duplicates',async()=>{
  const store=fakeStore(),home=mkdtempSync(join(tmpdir(),'single-persistence-'));
  try{
    await applyOwnerSinglePrices({store,privateInput,mode:'apply',home,out:()=>{}});
    const logs=[];
    const result=await inspectOwnerSinglePersistence({store,out:x=>logs.push(x)});
    assert.equal(result.quotes,2);assert.equal(result.identities,2);
    assert.equal(result.cardUnits,3);assert.equal(result.audits,1);
    assert.equal(store.writes,1);
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('gRPC code 3 is invalid argument, not evidence of failed authentication or network loss',()=>{
  assert.deepEqual(classifyFirestoreError({code:3,message:'3 INVALID_ARGUMENT: index size exceeded'}),
    {code:'3',category:'index-constraint'});
  assert.deepEqual(classifyFirestoreError({code:3,message:'INVALID_ARGUMENT: unknown'}),
    {code:'3',category:'invalid-argument-unspecified'});
  assert.deepEqual(classifyFirestoreError({code:7,message:'PERMISSION_DENIED'}),
    {code:'7',category:'permission-denied'});
});
