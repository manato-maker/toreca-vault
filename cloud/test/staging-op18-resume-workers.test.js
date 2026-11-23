import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2 } from '../../v2/core.js';
import { applyChatCommand } from '../src/v2-command.js';
import { buildCanonicalOnlyOpeningPlan } from '../scripts/staging-op18-provenance-repair.js';
import { validateRepairedCanonicalAndQueue, decideResume, run } from '../scripts/staging-op18-resume-workers.js';

const PRODUCT='ONE PIECEカードゲーム ブースターパック 神の支配【OP-18】';
const DATE='2026-11-22';
const PURCHASES=[
  ['normalchat:2026-11-22:furuichi-kyuhoji:onepiece-op18-purchase','ふるいち 久宝寺店'],
  ['normalchat:2026-11-22:biccamera-ario-yao:onepiece-op18-purchase','ビックカメラ アリオ八尾店'],
  ['normalchat:2026-11-22:mint-games-nihonbashi:onepiece-op18-purchase','ミントゲームズ日本橋店']
].map(([requestId,store])=>({requestId,store,type:'purchase',product:PRODUCT,category:'BOX',quantity:1,date:DATE,unitCost:5760}));
const SALE={
  requestId:'normalchat:2026-11-22:kaitori-mimi:onepiece-op18-day:god-dominion-sale',
  type:'sale',product:PRODUCT,category:'BOX',quantity:1,unitPrice:9000,date:DATE,store:'買取ミミ'
};
const SHEET_HASH='a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad';
const url='https://toreca-vault-staging-235108293761.asia-northeast1.run.app';
const project='project-8ff0bbc4-675d-4596-a8a';
const region='asia-northeast1';
function make(){
  let state=emptyV2();
  for(const command of [...PURCHASES,SALE])state=applyChatCommand(state,command).state;
  const canonicalBefore={revision:state.revision,lastMutationId:state.lastMutationId,payload:state};
  const {plan,opening}=buildCanonicalOnlyOpeningPlan(canonicalBefore);
  const canonical={revision:plan.payload.revision,lastMutationId:plan.mutationId,payload:plan.payload};
  const queueRow={requestId:opening.requestId,command:opening,status:'done',resultCode:'v2-applied',
    intakeReceipt:{spreadsheetIdHash:SHEET_HASH,rowNumber:64,state:'queued'}};
  return {canonical,queueRow,opening};
}
function job(name,endpoint,state='PAUSED'){
  return {name:'projects/'+project+'/locations/'+region+'/jobs/'+name,
    state,httpTarget:{uri:url+endpoint,httpMethod:'POST',
      oidcToken:{serviceAccountEmail:'staging@example.iam.gserviceaccount.com'}}};
}
function workers(){
  return {serviceUrl:url,jobs:[
    job('toreca-vault-staging-intake','/internal/worker/sheets-intake'),
    job('toreca-vault-staging-command-worker','/internal/worker/commands'),
    job('other-job','/other')
  ]};
}
function harness({receipt='queued',intake='PAUSED',commands='PAUSED'}={}){
  const f=make();
  f.queueRow.intakeReceipt.state=receipt;
  let jobs=workers();
  jobs.jobs[0].state=intake;
  jobs.jobs[1].state=commands;
  const resumes=[];
  return {
    f,resumes,
    store:{read:async()=>structuredClone(f.canonical)},
    queue:{inspect:async()=>structuredClone(f.queueRow)},
    readJobs:async()=>structuredClone(jobs),
    resumeJob:async name=>{
      resumes.push(name);
      const j=jobs.jobs.find(x=>x.name.endsWith('/jobs/'+name));
      if(!j)throw Error('invalid job');
      j.state='ENABLED';
    }
  };
}
test('completed opening includes exactly 2 source IDs and provenance after one CAS',()=>{
  const {canonical,queueRow}=make();
  const value=validateRepairedCanonicalAndQueue(canonical,queueRow);
  assert.deepEqual(value,{revision:5,requestId:queueRow.requestId,receiptState:'queued'});
});
test('the actual staging revision must match 2971; test fixture confirms guard rejects earlier snapshots',()=>{
  const {canonical,queueRow}=make();
  assert.throws(()=>validateRepairedCanonicalAndQueue(canonical,queueRow),/BLOCKED/);
});
test('strict original receipt, sale and opening mismatch guards refuse resuming',()=>{
  const sample=make();
  const changes=[
    x=>x.queueRow.status='pending',
    x=>x.queueRow.resultCode='retryable-error',
    x=>x.queueRow.intakeReceipt.rowNumber=65,
    x=>x.queueRow.intakeReceipt.spreadsheetIdHash='a'.repeat(64),
    x=>x.canonical.payload.transactions.find(tx=>tx.type==='opening').acquisitionCost=0,
    x=>x.canonical.payload.transactions.find(tx=>tx.type==='sale').sourcePurchaseRequestId='different'
  ];
  for(const change of changes){
    const copy=structuredClone(sample);change(copy);
    assert.throws(()=>validateRepairedCanonicalAndQueue(copy.canonical,copy.queueRow),/BLOCKED/);
  }
});
test('resume stage requires original receipt final before activating the command worker',()=>{
  const w={intake:{state:'ENABLED'},commands:{state:'PAUSED'}};
  assert.throws(()=>decideResume({kind:'commands',workers:w,verified:{revision:2971,receiptState:'queued'}}),/BLOCKED/);
  assert.equal(decideResume({kind:'commands',workers:w,verified:{revision:2971,receiptState:'final'}}),'commands');
  assert.throws(()=>decideResume({kind:'intake',workers:w,verified:{revision:2971}}),/BLOCKED/);
});
test('post-repair resume scripts are blocked until they inspect actual revision 2971',async()=>{
  const h=harness();const lines=[];
  await assert.rejects(()=>run({...h,action:'--status',output:s=>lines.push(s)}),/BLOCKED/);
  assert.deepEqual(h.resumes,[]);
});
