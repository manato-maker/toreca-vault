#!/usr/bin/env node
/**
 * Two-stage staging-only resume after exact OP-18 original-Intake repair.
 * Verifies canonical revision 2971, audit provenance and the original queue,
 * then resumes ONLY the already-verified staging Scheduler targets.
 * Stage 1 (intake) allows the status reconciler to finalize row-64 receipt.
 * Stage 2 (commands) waits for that finalized receipt and never retries.
 *
 * No Sheets, production, legacy V2, queue writes or Firestore writes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';
import { SOURCE_EVIDENCE, SALE_EVIDENCE, inspectCanonical } from './staging-op18-canonical-inspect.js';
import { verifiedStagingConfiguration } from './staging-scoped-opening-once.js';
import { exactStagingJobs, verifiedCurrentJobs } from './staging-op18-pause-workers.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const REGION = 'asia-northeast1';
const DOCUMENT = 'torecaVaultStaging/canonical';
const SHEET_HASH = 'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad';
const REPAIRED_REVISION = 2971;
const OPENING_HASH = '7b3a00c2513769733a652fb09c155d3586f9362c0c06c388996c6353e8527437';
function hash(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function blocked(reason) { throw new Error('BLOCKED: ' + reason); }
function matches(hashValue, list) {
  const result = list.filter(row => hash(row?.requestId) === hashValue);
  if(result.length !== 1) blocked('original transaction identity not unique');
  return result[0];
}

export function validateRepairedCanonicalAndQueue(canonical, queueRow) {
  const diag = inspectCanonical(canonical);
  if (canonical.revision !== REPAIRED_REVISION || diag.opening !== 'already-recorded'
    || !Object.values(diag.sourceLots).every(status => status === 'missing')) {
    blocked('staging canonical revision or post-opening inventory differs from verified repair');
  }
  const transactions=canonical.payload.transactions;
  const opening=matches(OPENING_HASH, transactions);
  const furuichi=matches(SOURCE_EVIDENCE.FURUICHI.idHash, transactions);
  const bic=matches(SOURCE_EVIDENCE.BIC.idHash, transactions);
  const mint=matches(SOURCE_EVIDENCE.MINT.idHash, transactions);
  const mintSale=matches(SALE_EVIDENCE.idHash, transactions);
  const openingId='chat-opening-'+opening.requestId;
  if(opening.id!==openingId || opening.type!=='opening'
    || Number(opening.quantity)!==2 || Number(opening.acquisitionCost)!==11520
    || JSON.stringify(opening.sourcePurchaseRequestIds)!==JSON.stringify([furuichi.requestId,bic.requestId])
    || JSON.stringify(opening.sourceLotIds)!==JSON.stringify([
      'chat-purchase-'+furuichi.requestId+'-lot',
      'chat-purchase-'+bic.requestId+'-lot'
    ])
    || opening.reconciledSaleTransactionId!==mintSale.id
    || opening.reconciledSoldPurchaseRequestId!==mint.requestId
    || mintSale.sourcePurchaseRequestId!==mint.requestId
    || Number(mintSale.price)!==9000
    || canonical.lastMutationId!=='chat:open-box:'+opening.requestId) {
    blocked('opening, sale provenance or original acquisition cost did not survive canonical readback');
  }
  const receipt=queueRow?.intakeReceipt;
  if(!queueRow || queueRow.requestId!==opening.requestId
    || queueRow.status!=='done' || queueRow.resultCode!=='v2-applied'
    || queueRow.command?.requestId!==opening.requestId
    || queueRow.command?.type!=='open-box' || Number(queueRow.command.quantity)!==2
    || receipt?.spreadsheetIdHash!==SHEET_HASH || receipt?.rowNumber!==64
    || !['queued','processing','final'].includes(receipt.state)) {
    blocked('original Intake #64 queue or sheet receipt correlation is incomplete');
  }
  return { revision:canonical.revision,requestId:opening.requestId,receiptState:receipt.state };
}
export function decideResume({kind,workers,verified}) {
  if(!['intake','commands'].includes(kind) || !verified || verified.revision!==REPAIRED_REVISION) {
    blocked('completed canonical inspection and exact resume stage required');
  }
  const intake=workers?.intake?.state,commands=workers?.commands?.state;
  if(kind==='intake' && intake==='PAUSED' && commands==='PAUSED')return 'intake';
  if(kind==='commands' && intake==='ENABLED' && commands==='PAUSED'
    && verified.receiptState==='final')return 'commands';
  blocked('worker isolation or original Intake receipt finalization not satisfied');
}
async function dataRead({store,queue,openingRequestId}={}) {
  const canonical=await store.read();
  if(!canonical)blocked('staging canonical missing');
  const opening=matches(OPENING_HASH,canonical.payload.transactions);
  if(openingRequestId && opening.requestId!==openingRequestId)blocked('opening request changed');
  const queueRow=await queue.inspect(opening.requestId);
  const verified=validateRepairedCanonicalAndQueue(canonical,queueRow);
  const queueUpdatedAtMs=queueRow?.updatedAtMs;
  if(!Number.isSafeInteger(queueUpdatedAtMs) || queueUpdatedAtMs < 1) {
    blocked('original queue completion timestamp unavailable; cannot safely finalize receipt');
  }
  return {...verified,queueUpdatedAtMs};
}
export async function run({action,store,queue,readJobs,resumeJob,output=console.log}={}) {
  if(!['--status','--resume-intake','--resume-commands'].includes(action)) {
    blocked('only --status, --resume-intake, --resume-commands are supported');
  }
  const initial=await dataRead({store,queue});
  const metadata=await readJobs();
  const workers=exactStagingJobs(metadata);
  output('Verified canonical revision: '+initial.revision);
  output('Opening 2 BOX, Mint sale attribution and ¥11520 purchase cost: verified');
  output('Original queue: done / v2-applied');
  output('Original Intake receipt correlation: '+initial.receiptState);
  output('Original queue updatedAtMs: '+initial.queueUpdatedAtMs);
  output('Staging intake Scheduler: '+workers.intake.state);
  output('Staging command Scheduler: '+workers.commands.state);
  if(action==='--status'){
    output('READ ONLY: no job or data changes');
    return {status:'inspect-only',...initial};
  }
  const kind=action==='--resume-intake'?'intake':'commands';
  decideResume({kind,workers,verified:initial});
  // Fresh metadata and canonical before scheduling mutation.
  const current=await dataRead({store,queue,openingRequestId:initial.requestId});
  const newest=exactStagingJobs(await readJobs());
  decideResume({kind,workers:newest,verified:current});
  await resumeJob(newest[kind].shortName);
  const after=exactStagingJobs(await readJobs());
  if(after[kind].state!=='ENABLED'
    || after[kind==='intake'?'commands':'intake'].state!==(kind==='intake'?'PAUSED':'ENABLED')) {
    blocked('staging Scheduler resume did not yield the required isolated state');
  }
  output('PASS: exact staging '+kind+' Scheduler ENABLED; no production or retry action');
  if(kind==='intake')output('Next: wait for Intake receipt finalization before resuming commands');
  return {status:'resumed-'+kind,...current};
}
async function main(args=process.argv.slice(2)) {
  if(args.length!==1 || !['--status','--resume-intake','--resume-commands'].includes(args[0])){
    blocked('use --status, --resume-intake or --resume-commands');
  }
  verifiedStagingConfiguration({apply:false});
  const { Firestore }=await import('@google-cloud/firestore');
  const db=new Firestore({projectId:PROJECT});
  const store=createFirestoreStore(db,DOCUMENT);
  const queue=createFirestoreCommandQueue(db);
  const resumeJob=async name=>{
    try{
      execFileSync('gcloud',['scheduler','jobs','resume',name,
        '--project',PROJECT,'--location',REGION],{encoding:'utf8',timeout:45000,maxBuffer:500000});
    }catch{blocked('staging Scheduler resume permission denied or operation failed');}
  };
  return run({action:args[0],store,queue,readJobs:()=>verifiedCurrentJobs(),resumeJob});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    const msg=String(error?.message||'');
    console.error(msg.startsWith('BLOCKED:')?msg:'BLOCKED: staging verification or Scheduler resume failed; details withheld');
    process.exitCode=2;
  });
}
