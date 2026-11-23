import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2 } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';
import { buildCanonicalOnlyOpeningPlan, checkOriginalQueue, run } from '../scripts/staging-op18-provenance-repair.js';

const PRODUCT = 'ONE PIECEカードゲーム ブースターパック 神の支配【OP-18】';
const DATE = '2026-11-22';
const purchases = [
  ['normalchat:2026-11-22:furuichi-kyuhoji:onepiece-op18-purchase','ふるいち 久宝寺店'],
  ['normalchat:2026-11-22:biccamera-ario-yao:onepiece-op18-purchase','ビックカメラ アリオ八尾店'],
  ['normalchat:2026-11-22:mint-games-nihonbashi:onepiece-op18-purchase','ミントゲームズ日本橋店']
].map(([requestId,store])=>({
  requestId,type:'purchase',product:PRODUCT,category:'BOX',quantity:1,
  date:DATE,unitCost:5760,store
}));
const sale = {
  requestId:'normalchat:2026-11-22:kaitori-mimi:onepiece-op18-day:god-dominion-sale',
  type:'sale',product:PRODUCT,category:'BOX',quantity:1,unitPrice:9000,
  date:DATE,store:'買取ミミ'
};
function data() {
  let state=emptyV2();
  for(const command of [...purchases,sale])state=applyChatCommand(state,command).state;
  return {revision:state.revision,lastMutationId:state.lastMutationId,payload:state};
}
function harness() {
  let current=data(),queued=null;
  const writes=[];
  const store={
    async read(){return structuredClone(current)},
    async save({expectedRevision,mutationId,payload}){
      assert.equal(expectedRevision,current.revision);
      assert.equal(mutationId,payload.lastMutationId);
      writes.push('canonical-save');
      current={revision:payload.revision,lastMutationId:mutationId,payload:structuredClone(payload)};
      return {...structuredClone(current),duplicate:false};
    }
  };
  const queue={
    async inspect(){return queued},
    async enqueue({requestId,command,intakeReceipt}){
      writes.push('queue-enqueue');
      assert.equal(requestId,command.requestId);
      assert.equal(intakeReceipt.rowNumber,64);
      queued={requestId,command,status:'pending',intakeReceipt};
      return {accepted:true,status:'pending'};
    },
    async claim(requestId){
      writes.push('queue-claim');
      assert.equal(requestId,queued.requestId);
      queued.status='processing';
      return {claimed:true,claimToken:'original-lease',command:structuredClone(queued.command)};
    },
    async finish(requestId,claimToken,{outcome,resultCode}){
      writes.push('queue-finish');
      assert.equal(requestId,queued.requestId);
      assert.equal(claimToken,'original-lease');
      assert.equal(resultCode,'v2-applied');
      queued.status=outcome;
      return {updated:true,status:outcome};
    }
  };
  return {store,queue,writes,get:()=>structuredClone(current)};
}

test('verified canonical-only plan corrects exactly historical BicCamera FIFO attribution',()=>{
  const original=data(),copy=structuredClone(original);
  assert.equal(original.payload.inventoryLots.length,2);
  assert.equal(original.payload.inventoryLots.some(l=>l.store==='ビックカメラ アリオ八尾店'),false);
  const result=buildCanonicalOnlyOpeningPlan(original);
  assert.equal(result.plan.expectedRevision,4);
  assert.equal(result.plan.expectedCost,11520);
  assert.equal(result.plan.quantity,2);
  assert.equal(result.plan.provenanceCorrection.sourcePurchaseRequestId,purchases[2].requestId);
  assert.equal(result.plan.provenanceCorrection.replacedMissingLotId,
    'chat-purchase-'+purchases[1].requestId+'-lot');
  assert.equal(result.plan.payload.inventoryLots.length,0);
  assert.equal(result.plan.payload.transactions.filter(tx=>tx.type==='purchase').length,3);
  assert.deepEqual(original,copy);
});

test('canonical-only inspect never touches queue, canonical or backups',async()=>{
  const h=harness(),messages=[];
  const result=await run({...h,apply:false,out:x=>messages.push(x)});
  assert.equal(result.status,'inspect-only');
  assert.equal(result.revision,4);
  assert.deepEqual(h.writes,[]);
  assert.match(messages.join('\n'),/READ ONLY/);
  assert.doesNotMatch(messages.join('\n'),/normalchat:|sourceTransactionId/);
});

test('queue identity must match the exact existing opening and receipt',()=>{
  const opening=buildCanonicalOnlyOpeningPlan(data()).opening;
  const receipt={spreadsheetIdHash:'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad',rowNumber:64};
  assert.doesNotThrow(()=>checkOriginalQueue(null,opening));
  assert.doesNotThrow(()=>checkOriginalQueue({status:'pending',command:opening,intakeReceipt:receipt},opening));
  assert.throws(()=>checkOriginalQueue({status:'done',command:opening,intakeReceipt:receipt},opening),/BLOCKED/);
  assert.throws(()=>checkOriginalQueue({status:'pending',command:{...opening,quantity:1},intakeReceipt:receipt},opening),/BLOCKED/);
  assert.throws(()=>checkOriginalQueue({status:'pending',command:opening,intakeReceipt:{...receipt,rowNumber:65}},opening),/BLOCKED/);
});

test('write mode refuses missing approvals or stale revision before any mutation',async()=>{
  const h=harness();
  const old1=process.env.TV_STAGING_REPAIR_APPROVED,old2=process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  delete process.env.TV_STAGING_REPAIR_APPROVED;
  delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  try{
    await assert.rejects(()=>run({...h,apply:true,expectedRevision:4,backup:()=>{throw Error('SHOULD_NOT_BACKUP')}}),/BLOCKED/);
    process.env.TV_STAGING_REPAIR_APPROVED='true';
    process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED='true';
    await assert.rejects(()=>run({...h,apply:true,expectedRevision:3,backup:()=>{throw Error('SHOULD_NOT_BACKUP')}}),/BLOCKED/);
    assert.deepEqual(h.writes,[]);
  }finally{
    if(old1===undefined)delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED=old1;
    if(old2===undefined)delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
    else process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED=old2;
  }
});

test('authorized exact repair applies one revision CAS and keeps all 3 purchases unchanged',async()=>{
  const h=harness(),oldPurchases=h.get().payload.transactions.filter(t=>t.type==='purchase');
  const old1=process.env.TV_STAGING_REPAIR_APPROVED,old2=process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
  process.env.TV_STAGING_REPAIR_APPROVED='true';
  process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED='true';
  let backups=0;
  try{
    const result=await run({...h,apply:true,expectedRevision:4,backup:()=>{backups++},out:()=>{}});
    assert.equal(result.status,'canonical-readback-verified-queue-done');
    assert.equal(result.revision,5);
    assert.equal(backups,1);
    assert.deepEqual(h.writes,['queue-enqueue','queue-claim','canonical-save','queue-finish']);
    const after=h.get().payload;
    assert.equal(after.inventoryLots.length,0);
    assert.deepEqual(after.transactions.filter(t=>t.type==='purchase'),oldPurchases);
    assert.equal(after.transactions.find(t=>t.type==='sale').price,9000);
    assert.equal(after.transactions.find(t=>t.type==='sale').sourcePurchaseRequestId,purchases[2].requestId);
    assert.equal(after.transactions.find(t=>t.type==='opening').quantity,2);
    assert.equal(after.transactions.find(t=>t.type==='opening').acquisitionCost,11520);
    await assert.rejects(()=>run({...h,apply:false,out:()=>{}}),/BLOCKED/);
    assert.equal(h.writes.length,4);
  }finally{
    if(old1===undefined)delete process.env.TV_STAGING_REPAIR_APPROVED;
    else process.env.TV_STAGING_REPAIR_APPROVED=old1;
    if(old2===undefined)delete process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED;
    else process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED=old2;
  }
});
