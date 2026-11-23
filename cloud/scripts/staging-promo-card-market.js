#!/usr/bin/env node
/**
 * Authenticated Cloud Shell; STAGING ONLY.
 * One explicit bonus pack cost correction plus private read-only card listing.
 * No new Intake queue, no transaction mutation, no scheduler change,
 * no external upload or unauthenticated endpoint.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';
import { previewScopedCostCorrection, singleCardResearchList } from '../src/single-card-market-setup.js';

const PROJECT='project-8ff0bbc4-675d-4596-a8a', NUMBER='235108293761';
const DOC='torecaVaultStaging/canonical';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function blocked(msg){throw new Error('BLOCKED: '+msg);}
function stepError(step,error){
  if(String(error?.message||'').startsWith('BLOCKED:'))return error;
  const code=String(error?.code||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,36);
  const name=String(error?.name||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,36);
  const detail=code||name||'unknown';
  return new Error('BLOCKED: scoped staging '+step+' failed ('+detail+'); no unverified write claims');
}
function checkProject(runner=execFileSync) {
  let result;
  try {result=String(runner('gcloud',['projects','describe',PROJECT,'--format=value(projectNumber)'],
    {encoding:'utf8',timeout:20000})).trim();}
  catch {blocked('staging project authentication unavailable');}
  if(result!==NUMBER)blocked('wrong project; no writes allowed');
}
export async function reconcilePromoAndExportSingles({
  store,mode='inspect',write=writeFileSync,read=readFileSync,chmod=chmodSync,
  home=homedir(),now=new Date(),privateInput,say=console.log
}={}) {
  if(!['inspect','apply'].includes(mode)||!store||typeof store.read!=='function')blocked('invalid store or mode');
  let original;
  try{original=await store.read();}catch(e){throw stepError('initial read',e);}
  if(!original?.payload||original.revision!==original.payload.revision)blocked('canonical revision mismatch');
  const preview=previewScopedCostCorrection(original.payload,privateInput);
  say('PASS: one exact scoped inventory cost target found');
  say('Current cost correction: '+(preview.alreadyCorrect?'already applied':'awaiting update'));
  let current=original,changed=false;
  if(mode==='apply'&&!preview.alreadyCorrect){
    if(typeof store.save!=='function')blocked('staging-only canonical write unavailable');
    const backup=join(home,'toreca-staging-before-scoped-cost-rev'+original.revision+'.json');
    try {write(backup,JSON.stringify(original.payload),{encoding:'utf8',mode:0o600,flag:'wx'});}
    catch(error){
      if(error?.code!=='EEXIST')throw stepError('private backup write',error);
      let existing;
      try{existing=JSON.parse(read(backup,'utf8'));}catch{blocked('existing private backup unreadable');}
      if(!eq(existing,original.payload))blocked('existing backup conflicts with current canonical; no writes');
      say('PASS: exact matching private backup reused');
    }
    say('PASS: private staging canonical backup verified');
    try{
      await store.save({expectedRevision:original.revision,mutationId:preview.mutationId,payload:preview.state});
    }catch(error){
      // Firestore may have committed yet a postwrite network read failed.
      // Never assume failure means the mutation was not applied.
      let recovered=null;
      try{recovered=await store.read();}catch{}
      if(recovered?.revision===original.revision+1 &&
        recovered.payload?.lastMutationId===preview.mutationId &&
        eq(recovered.payload.inventoryLots,preview.state.inventoryLots) &&
        eq(recovered.payload.marketQuotes,original.payload.marketQuotes) &&
        eq(recovered.payload.transactions,original.payload.transactions) &&
        eq(recovered.payload.lotteries,original.payload.lotteries)) {
        say('PASS: Firestore save reported an error, but canonical readback verifies the exact requested change');
        current=recovered;
      }else throw stepError('Firestore save',error);
    }
    if(current===original){
      try{current=await store.read();}catch(e){throw stepError('postwrite readback',e);}
    }
    if(current?.revision!==original.revision+1||
      current.payload?.lastMutationId!==preview.mutationId||
      !eq(current.payload.inventoryLots,preview.state.inventoryLots)||
      !eq(current.payload.marketQuotes,original.payload.marketQuotes)||
      !eq(current.payload.transactions,original.payload.transactions)||
      !eq(current.payload.lotteries,original.payload.lotteries))blocked('postwrite readback failed; stop');
    say('PASS: staging scoped cost corrected; transaction history and all other lots unchanged');
    changed=true;
  } else if(mode==='apply')say('PASS: approved cost already present; no duplicate write');
  else say('READ ONLY: preview only');
  let exportData;
  try{exportData=singleCardResearchList(current,now);}catch(e){throw stepError('single card list build',e);}
  say('PASS: single-card inventory: '+exportData.lots+' lots / '+exportData.quantity+' cards');
  const path=join(home,'toreca-single-cards-for-market.txt');
  // Preview must not write to disk; the apply command writes only an owner-
  // private text file and the scoped correction above.
  if(mode==='apply'){
    try{
      write(path,exportData.text,{encoding:'utf8',mode:0o600});
      chmod(path,0o600);
    }catch(e){throw stepError('private single card file write',e);}
    say('Private card research list: '+path);
    say('--- COPY FOR CARD MARKET RESEARCH ---');
    say(exportData.text);
  }
  return {changed,revision:current.revision,scopeCorrect:preview.alreadyCorrect||changed,
    cardLots:exportData.lots,cardQuantity:exportData.quantity};
}
async function main(args=process.argv.slice(2)){
  if(args.length!==1||!['--inspect','--apply'].includes(args[0]))blocked('use --inspect or --apply');
  if(args[0]==='--apply'&&process.env.TV_STAGING_COST_CORRECTION_APPROVED!=='YES')
    blocked('explicit staging cost correction authorization required');
  checkProject();
  const {Firestore}=await import('@google-cloud/firestore');
  const store=createFirestoreStore(new Firestore({projectId:PROJECT}),DOC);
  const parsePositive=value=>/^(0|[1-9]\d*)$/.test(String(value||''))?Number(value):NaN;
  const privateInput={
    productName:process.env.TV_STAGING_COST_PRODUCT,
    category:process.env.TV_STAGING_COST_CATEGORY,
    expectedCost:parsePositive(process.env.TV_STAGING_COST_BEFORE),
    newCost:parsePositive(process.env.TV_STAGING_COST_AFTER),
    expectedQuantity:parsePositive(process.env.TV_STAGING_COST_QUANTITY)
  };
  await reconcilePromoAndExportSingles({store,privateInput,mode:args[0].slice(2)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    const msg=String(error?.message||'');
    console.error(msg.startsWith('BLOCKED:')?msg:'BLOCKED: scoped staging step failed; private backup and current revision require readback');
    process.exitCode=2;
  });
}
