import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyV2 } from '../../v2/core.js';
import { previewScopedCostCorrection, singleCardResearchList, readCostCorrection } from '../src/single-card-market-setup.js';
import { reconcilePromoAndExportSingles, exportSingleCardsOnly } from '../scripts/staging-promo-card-market.js';

const input={productName:'テスト用付属パック',category:'パック',
  expectedCost:250,newCost:0,expectedQuantity:1};
function snapshot(){
  const s=emptyV2();s.revision=3000;
  s.inventoryLots=[
    {id:'target',product:'テスト用付属パック',category:'パック',condition:'未開封',
      quantity:1,unitCost:250,acquiredAt:'2026-04-01'},
    {id:'ordinary',product:'テスト用通常パック',category:'パック',
      quantity:2,unitCost:250},
    {id:'card1',product:'テストカードA SAR',productKey:'テストカードA SAR',
      category:'カード',condition:'良品',quantity:1,unitCost:0,
      cardNumber:'001/099',rarity:'SAR'},
    {id:'card2',product:'テストカードB',category:'カード',quantity:2,
      condition:'良品',unitCost:0}
  ];
  return s;
}
function stub(state=snapshot()){
  let payload=structuredClone(state),saves=0;
  return {
    get saves(){return saves;},
    async read(){return {revision:payload.revision,payload:structuredClone(payload)};},
    async save({expectedRevision,mutationId,payload:next}){
      assert.equal(expectedRevision,payload.revision);
      assert.equal(mutationId,readCostCorrection(input).mutationId);
      assert.equal(next.revision,expectedRevision+1);
      payload=structuredClone(next);saves++;
    }
  };
}
test('zero only the scoped exact lot; do not touch purchase, sales, quotes or other inventory',()=>{
  const s=snapshot();s.transactions.push({id:'tx1',type:'purchase',product:'test',price:250});
  s.marketQuotes.push({product:'test',price:800});
  const before=structuredClone(s);
  const v=previewScopedCostCorrection(s,input);
  assert.equal(v.state.inventoryLots[0].unitCost,0);
  assert.equal(v.state.inventoryLots[1].unitCost,250);
  assert.deepEqual(v.state.transactions,before.transactions);
  assert.deepEqual(v.state.marketQuotes,before.marketQuotes);
  assert.deepEqual(v.state.lotteries,before.lotteries);
  assert.equal(v.state.auditLog.at(-1).mutationId,readCostCorrection(input).mutationId);
  assert.equal(v.state.revision,s.revision+1);
  assert.deepEqual(s,before);
  const repeat=previewScopedCostCorrection(v.state,input);
  assert.equal(repeat.alreadyCorrect,true);
  assert.deepEqual(repeat.state,v.state);
});
test('exact product, category, quantity and approved cost fail closed',()=>{
  let s=snapshot();s.inventoryLots[0].unitCost=900;
  assert.throws(()=>previewScopedCostCorrection(s,input),/existing cost differs/);
  s=snapshot();s.inventoryLots[0].quantity=2;
  assert.throws(()=>previewScopedCostCorrection(s,input),/quantity/);
  s=snapshot();s.inventoryLots.push({...s.inventoryLots[0],id:'dup'});
  assert.throws(()=>previewScopedCostCorrection(s,input),/exactly one/);
  s=snapshot();s.inventoryLots[0].product='別の商品';
  assert.throws(()=>previewScopedCostCorrection(s,input),/exactly one/);
  assert.throws(()=>readCostCorrection({...input,expectedCost:-1}),/invalid private/);
});
test('card research export never includes cost, store, transaction or lot id',()=>{
  const s=snapshot();
  const v=singleCardResearchList({revision:3000,payload:s},new Date('2026-11-23T06:00:00Z'));
  assert.equal(v.lots,2);assert.equal(v.quantity,3);
  assert.match(v.text,/15:00 JST/);
  assert.match(v.text,/テストカードA SAR.*001\/099.*SAR/);
  assert.match(v.text,/カードラッシュ（買取リスト）/);
  assert.match(v.text,/アルテマ（ポケカチ）/);
  assert.match(v.text,/7日より古い価格/);
  assert.doesNotMatch(v.text,/card1|card2|原価|unitCost|250円/);
});
test('one CLI invocation corrects canonical once then exports a private single card list',async()=>{
  const store=stub(),logs=[],writes=[],chmods=[];
  const args={store,privateInput:input,now:new Date('2026-11-23T06:00:00Z'),
    home:'/private',say:v=>logs.push(v),
    write:(path,contents,opts)=>writes.push({path,contents,opts}),
    read:()=>{throw Error('should not read backup')},chmod:(path,mode)=>chmods.push({path,mode})};
  const pre=await reconcilePromoAndExportSingles({...args,mode:'inspect'});
  assert.equal(pre.changed,false);assert.equal(store.saves,0);assert.equal(writes.length,0);
  const updated=await reconcilePromoAndExportSingles({...args,mode:'apply'});
  assert.equal(updated.changed,true);assert.equal(updated.scopeCorrect,true);
  assert.equal(store.saves,1);
  assert.equal(writes.length,2);
  assert.match(writes[0].path,/toreca-staging-before-scoped-cost-rev3000.json/);
  assert.equal(writes[0].opts.mode,0o600);assert.equal(writes[0].opts.flag,'wx');
  assert.match(writes[1].path,/toreca-single-cards-for-market.txt/);
  assert.equal(writes[1].opts.mode,0o600);assert.equal(chmods[0].mode,0o600);
  const repeated=await reconcilePromoAndExportSingles({...args,mode:'apply'});
  assert.equal(repeated.changed,false);assert.equal(store.saves,1);
  assert.match(logs.join('\n'),/PASS: staging scoped cost corrected/);
});

test('a failed staging save identifies the failing step and reuse of exactly matching backup works',async()=>{
  const home=mkdtempSync(join(tmpdir(),'staging-single-cost-'));
  try{
    const backing=stub();
    let fail=true;
    const store={
      read:()=>backing.read(),
      async save(args){
        if(fail){fail=false;const e=new Error('simulated sensitive cloud reason');e.code='PERMISSION_DENIED';throw e;}
        return backing.save(args);
      }
    };
    await assert.rejects(
      reconcilePromoAndExportSingles({store,privateInput:input,mode:'apply',home,say:()=>{}}),
      /BLOCKED: scoped staging Firestore save failed \(PERMISSION_DENIED\)/
    );
    assert.equal(backing.saves,0);
    const output=[];
    const result=await reconcilePromoAndExportSingles({store,privateInput:input,mode:'apply',home,say:x=>output.push(x)});
    assert.equal(result.changed,true);
    assert.equal(backing.saves,1);
    assert.match(output.join('\n'),/exact matching private backup reused/);
    const again=await reconcilePromoAndExportSingles({store,privateInput:input,mode:'apply',home,say:()=>{}});
    assert.equal(again.changed,false);
    assert.equal(backing.saves,1);
  }finally{rmSync(home,{force:true,recursive:true});}
});

test('if Firestore saved successfully but response failed, canonical readback recognizes success',async()=>{
  const home=mkdtempSync(join(tmpdir(),'staging-single-postwrite-'));
  try{
    const backing=stub();
    const store={
      read:()=>backing.read(),
      async save(args){
        await backing.save(args);
        const error=new Error('lost connection after successful commit');
        error.code='UNAVAILABLE';
        throw error;
      }
    };
    const logs=[];
    const result=await reconcilePromoAndExportSingles({store,privateInput:input,mode:'apply',home,say:x=>logs.push(x)});
    assert.equal(result.changed,true);
    assert.equal(backing.saves,1);
    assert.match(logs.join('\n'),/canonical readback verifies the exact requested change/);
  }finally{rmSync(home,{force:true,recursive:true});}
});

test('V2 setCardIdentity previously recorded card numbers are exported from lot.set',()=>{
  const state=snapshot();
  // The actual V2 field populated by setCardIdentity() is "set".
  state.inventoryLots[2].set='M6a 127/103';
  state.inventoryLots[3].set='PROMO 001/SV-P';
  const report=singleCardResearchList({revision:state.revision,payload:state},
    new Date('2026-11-23T06:00:00Z'));
  assert.match(report.text,/テストカードA SAR｜1枚｜番号要確認（識別情報不一致）｜M6a｜SAR/);
  assert.match(report.text,/テストカードB｜2枚｜001\/SV-P｜PROMO/);
  assert.match(report.text,/lot\.set（V2登録済みの識別情報）/);
});
test('V2 legacy purchase set is read when the inventory lot has no set',()=>{
  const state=snapshot();
  state.inventoryLots[3].sourceTransactionId='purchase-abc';
  state.transactions.push({id:'purchase-abc',type:'purchase',set:'mF 044/040'});
  const report=singleCardResearchList({revision:state.revision,payload:state},
    new Date('2026-11-23T06:00:00Z'));
  assert.match(report.text,/テストカードB｜2枚｜044\/040｜mF/);
});
test('new read-only re-export does not require the cost correction or mutate canonical',async()=>{
  const backing=stub();
  const writes=[],log=[];
  const data=await exportSingleCardsOnly({store:backing,home:'/private',
    now:new Date('2026-11-23T06:00:00Z'),
    say:message=>log.push(message),
    write:(path,contents,opts)=>writes.push({path,contents,opts}),chmod:()=>{}});
  assert.equal(backing.saves,0);
  assert.deepEqual({revision:data.revision,lots:data.lots,quantity:data.quantity},
    {revision:3000,lots:2,quantity:3});
  assert.equal(writes.length,1);
  assert.equal(writes[0].opts.mode,0o600);
  assert.match(writes[0].path,/toreca-single-cards-for-market\.txt/);
  assert.match(log.join('\n'),/canonical remains unchanged/);
});
