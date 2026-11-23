#!/usr/bin/env node
/**
 * Operator-authenticated STAGING-ONLY import of owner-approved, unverified
 * and dated single-card market references. Neither quotes nor card holdings
 * are hardcoded into the public repo. Does not alter purchases, sales,
 * cost, quantities, queues, schedulers, old V2 or production.
 */
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createFirestoreStore} from '../src/firestore-store.js';
import {previewOwnerSinglePrices} from '../src/owner-single-buyback-reported.js';

const PROJECT='project-8ff0bbc4-675d-4596-a8a';
const PROJECT_NUMBER='235108293761';
const DOC='torecaVaultStaging/canonical';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function blocked(reason){throw new Error('BLOCKED: '+reason);}
function verifyProject(executor=execFileSync){
  let actual;
  try{actual=String(executor('gcloud',['projects','describe',PROJECT,'--format=value(projectNumber)'],
    {encoding:'utf8',timeout:20000})).trim();}
  catch{blocked('staging project authorization unavailable');}
  if(actual!==PROJECT_NUMBER)blocked('wrong project; no writes');
}
export async function applyOwnerSinglePrices({store,privateInput,mode='inspect',
  write=writeFileSync,read=readFileSync,home=homedir(),out=console.log}={}){
  if(!['inspect','apply'].includes(mode)||!store||typeof store.read!=='function')blocked('unsupported mode or store');
  const before=await store.read();
  if(!before?.payload||before.revision!==before.payload.revision)blocked('canonical snapshot inconsistent');
  const result=previewOwnerSinglePrices(before.payload,privateInput);
  if(result.alreadyApplied){
    out('PASS: owner singles report already applied; duplicate write skipped');
    out('Canonical revision: '+before.revision);
    return {alreadyApplied:true,applied:false};
  }
  out('PASS: registered card set identifiers, quantities and price dates matched');
  out('Matched lots: '+result.changed+' / card units: '+result.pricedCards);
  out('Unpriced card units: '+result.unpricedCards);
  out('Indicative owner-report yen: '+result.reportedTotalYen+' (unverified original source)');
  if(mode==='inspect'){
    out('READ ONLY: no cloud or local files written');
    return {applied:false,...result,state:undefined};
  }
  if(typeof store.save!=='function')blocked('staging canonical write unavailable');
  const backup=join(home,'toreca-staging-before-owner-singles-rev'+before.revision+'.json');
  try{write(backup,JSON.stringify(before.payload),{encoding:'utf8',mode:0o600,flag:'wx'});}
  catch(e){
    if(e?.code!=='EEXIST')blocked('private backup creation failed ('+String(e?.code||'unknown')+')');
    let existing;
    try{existing=JSON.parse(read(backup,'utf8'));}catch{blocked('existing private backup unreadable');}
    if(!same(existing,before.payload))blocked('previous private backup does not match current canonical');
    out('PASS: exact matching staging backup reused');
  }
  try{
    await store.save({expectedRevision:before.revision,mutationId:result.mutationId,payload:result.state});
  }catch(error){
    let observed;
    try{observed=await store.read();}catch{}
    if(observed?.revision!==before.revision+1 ||
      observed?.payload?.lastMutationId!==result.mutationId ||
      !same(observed.payload.marketQuotes,result.state.marketQuotes) ||
      !same(observed.payload.inventoryLots,before.payload.inventoryLots) ||
      !same(observed.payload.transactions,before.payload.transactions) ||
      !same(observed.payload.lotteries,before.payload.lotteries)) {
      const diag=classifyFirestoreError(error);
      blocked('Firestore save or readback failed ('+diag.code+':'+diag.category+'); do not retry blindly');
    }
  }
  const after=await store.read();
  if(after?.revision!==before.revision+1||after?.payload?.lastMutationId!==result.mutationId||
    !same(after.payload.marketQuotes,result.state.marketQuotes) ||
    !same(after.payload.inventoryLots,before.payload.inventoryLots)||
    !same(after.payload.transactions,before.payload.transactions)||
    !same(after.payload.lotteries,before.payload.lotteries)) {
    blocked('postwrite canonical readback mismatched; stop');
  }
  out('PASS: provisional singles buyback references saved to staging canonical');
  out('PASS: inventory quantities, acquisition costs, purchases, sales and lotteries unchanged');
  out('New canonical revision: '+after.revision);
  return {applied:true,revision:after.revision,changed:result.changed};
}
/** Read-only diagnostic for owner singles market import. No private quotes required. */
export async function inspectOwnerSinglePersistence({store,out=console.log}={}){
  if(!store||typeof store.read!=='function')blocked('staging read unavailable');
  const state=await store.read();
  if(!state?.payload||state.revision!==state.payload.revision)blocked('canonical missing or revision mismatch');
  const q=state.payload.marketQuotes.filter(row=>row?.quoteBasis==='owner-chat-researched-single-buyback-v1');
  const unique=new Set(q.map(row=>row.cardIdentity));
  const qtyByLot=new Map(state.payload.inventoryLots.map(l=>[l.id,l.quantity]));
  const cardUnits=[...new Map(q.map(row=>[row.lotId,row])).values()].reduce((sum,row)=>
    sum+(Number(qtyByLot.get(row.lotId))||0),0);
  const audit=state.payload.auditLog.filter(row=>row?.kind==='owner-chat-single-card-reference-import');
  const marketQuoteBytes=Buffer.byteLength(JSON.stringify(state.payload.marketQuotes),'utf8');
  const snapshotBytes=Buffer.byteLength(JSON.stringify(state.payload),'utf8');
  out('READ ONLY: staging canonical revision '+state.revision);
  out('Owner singles reference quotes present: '+q.length+' / unique identities: '+unique.size);
  out('Matched current units (unique lots): '+cardUnits);
  out('Owner singles import audit records: '+audit.length);
  out('Snapshot size: '+snapshotBytes+' bytes; market quotes size: '+marketQuoteBytes+' bytes');
  out('No inventory, costs, sales, schedulers or dashboard changed');
  return {revision:state.revision,quotes:q.length,identities:unique.size,cardUnits,audits:audit.length};
}
/** Classify the API's gRPC code without exposing Firestore document content. */
export function classifyFirestoreError(error){
  const msg=String(error?.details||error?.message||'');
  const code=String(error?.code??'unknown');
  let category='unknown';
  if(code==='3'){
    category=/index/i.test(msg)?'index-constraint'
      :/size|large|exceed|limit|10 mib|10mb/i.test(msg)?'request-or-document-size'
      :/transaction/i.test(msg)?'transaction-argument'
      :/field|value|data/i.test(msg)?'field-value-argument':'invalid-argument-unspecified';
  } else if(code==='8')category='resource-exhausted';
  else if(code==='7')category='permission-denied';
  else if(code==='4')category='deadline-exceeded';
  else if(code==='10')category='concurrent-revision-change';
  return {code,category};
}
async function main(args=process.argv.slice(2)){
  if(args.length!==1||!['--status','--inspect','--apply'].includes(args[0]))blocked('only --status, --inspect or --apply');
  if(args[0]==='--apply'&&process.env.TV_SINGLES_REPORT_APPROVED!=='YES')
    blocked('explicit staging-only quote approval missing');
  verifyProject();
  const privateInput={
    priceSpec:process.env.TV_SINGLES_QUOTE_SPEC,
    reportDate:process.env.TV_SINGLES_REPORT_DATE,
    expectedLots:Number(process.env.TV_SINGLES_EXPECTED_LOTS),
    expectedCards:Number(process.env.TV_SINGLES_EXPECTED_CARDS)
  };
  const {Firestore}=await import('@google-cloud/firestore');
  const store=createFirestoreStore(new Firestore({projectId:PROJECT}),DOC);
  if(args[0]==='--status')return inspectOwnerSinglePersistence({store});
  await applyOwnerSinglePrices({store,privateInput,mode:args[0].slice(2)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    const msg=String(error?.message||'');
    console.error(msg.startsWith('BLOCKED:')?msg:'BLOCKED: scoped single-card staging import failed; do not retry blindly');
    process.exitCode=2;
  });
}
