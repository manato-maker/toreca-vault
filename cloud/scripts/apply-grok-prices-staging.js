#!/usr/bin/env node
/**
 * Exact owner-attested Grok buyback and BOX condition repair for STAGING ONLY.
 * - Never writes old V2, prod, Sheets, queues, schedulers, sales or purchases.
 * - Saves private local pre-write JSON backup before CAS.
 * - Grok figures remain "review / unverified" even after successful apply.
 * - Uses latest current revision, idempotent audit marker and postwrite readback.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFirestoreStore } from '../src/firestore-store.js';
import { previewGrokReportedPrices } from '../src/grok-buyback-reported.js';

const PROJECT='project-8ff0bbc4-675d-4596-a8a';
const PROJECT_NUMBER='235108293761';
const DOCUMENT='torecaVaultStaging/canonical';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function blocked(message){throw new Error('BLOCKED: '+message);}
function checkProject(runner=execFileSync){
  let actual;
  try {actual=String(runner('gcloud',['projects','describe',PROJECT,
    '--format=value(projectNumber)'],{encoding:'utf8',timeout:20000})).trim();}
  catch {blocked('staging project verification failed');}
  if(actual!==PROJECT_NUMBER)blocked('project number mismatch');
}
export async function applyGrokReportedPrices({store,privateInput,mode='inspect',write=writeFileSync,
  home=homedir(),display=console.log}={}) {
  if(!store || typeof store.read!=='function')blocked('store read unavailable');
  if(mode!=='inspect'&&mode!=='apply')blocked('unsupported operation');
  const before=await store.read();
  if(!before?.payload || before.revision!==before.payload.revision)blocked('canonical revision invalid');
  const result=previewGrokReportedPrices(before.payload,privateInput);
  const summary={revisionBefore:before.revision,reportAlreadyApplied:result.idempotent,
    conditionLotsUpdated:result.changed,grokReportQuotesAdded:result.added,
    reportedTotalYen:result.priceTotalYen,verifiedXPosts:0};
  if(mode==='inspect'||result.idempotent) {
    display('PASS: staging Grok report '+(result.idempotent?'already applied':'preview only')+'; no cloud writes');
    display(JSON.stringify(summary));
    return {...summary,applied:false};
  }
  if(typeof store.save!=='function')blocked('staging canonical save unavailable');
  const backup=join(home,'toreca-staging-before-grok-rev'+before.revision+'-'+privateInput.reportDate+'.json');
  write(backup,JSON.stringify(before.payload),{encoding:'utf8',mode:0o600,flag:'wx'});
  await store.save({expectedRevision:before.revision,mutationId:result.mutationId,payload:result.state});
  const after=await store.read();
  if(!after?.payload || after.revision!==before.revision+1
    || after.payload.lastMutationId!==result.mutationId
    || !eq(after.payload.inventoryLots,result.state.inventoryLots)
    || !eq(after.payload.marketQuotes,result.state.marketQuotes)
    || !eq(after.payload.transactions,before.payload.transactions)
    || !eq(after.payload.lotteries,before.payload.lotteries)) {
    blocked('canonical readback mismatched; backup remains private');
  }
  display('PASS: staging BOX conditions and Grok provisional prices applied; canonical readback verified');
  display(JSON.stringify({...summary,revisionAfter:after.revision,applied:true,backupFile:backup}));
  return {...summary,revisionAfter:after.revision,applied:true};
}
async function main(){
  const mode=process.argv[2];
  if(process.argv.length!==3 || !['--inspect','--apply'].includes(mode)) {
    blocked('only --inspect or --apply is accepted');
  }
  if(mode==='--apply'&&process.env.TV_GROK_PRICES_APPROVED!=='YES') {
    blocked('explicit staging-only Grok price update authorization missing');
  }
  checkProject();
  const {Firestore}=await import('@google-cloud/firestore');
  const store=createFirestoreStore(new Firestore({projectId:PROJECT}),DOCUMENT);
  const privateInput={
    reportDate:process.env.TV_GROK_REPORT_DATE,
    stockSpec:process.env.TV_GROK_STOCK,
    priceSpec:process.env.TV_GROK_PRICES
  };
  await applyGrokReportedPrices({store,privateInput,mode:mode.slice(2)});
}
if(import.meta.url===new URL('file://'+process.argv[1]).href) {
  main().catch(error=>{
    const msg=String(error?.message||'');
    console.error(msg.startsWith('BLOCKED:')?msg:'BLOCKED: Grok staging apply unavailable; no blind retries');
    process.exitCode=2;
  });
}
