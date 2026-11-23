#!/usr/bin/env node
/**
 * Read the owner-authorized staging canonical and export a shareable
 * product/quantity/packaging list. Firestore, Sheets and Scheduler READ ONLY.
 * The only write is a private .txt file in Cloud Shell HOME.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';
import { buildBoxBuybackExport, formatBoxBuybackExport } from '../src/box-buyback-export.js';

const PROJECT='project-8ff0bbc4-675d-4596-a8a';
const NUMBER='235108293761';
const DOCUMENT='torecaVaultStaging/canonical';
const OUT='toreca-boxes-for-grok.txt';

function blocked(reason) { throw new Error('BLOCKED: '+reason); }
function checkProject(gcloud=execFileSync) {
  let actual;
  try {
    actual=String(gcloud('gcloud',['projects','describe',PROJECT,
      '--format=value(projectNumber)'],{encoding:'utf8',timeout:20000})).trim();
  } catch { blocked('staging project or operator gcloud authentication could not be verified'); }
  if(actual!==NUMBER)blocked('unexpected project number; no export performed');
}
export async function exportCurrentBoxes({store,write=writeFileSync,chmod=chmodSync,
  destination=join(homedir(),OUT),now=new Date(),display=console.log}={}) {
  if(!store || typeof store.read!=='function')throw new TypeError('read-only canonical store required');
  const canonical=await store.read();
  const result=buildBoxBuybackExport(canonical);
  const contents=formatBoxBuybackExport(result,now);
  // Product names and stock quantities are sensitive to the owner: local
  // machine only, 0600, no upload and no public URL.
  write(destination,contents,{encoding:'utf8',mode:0o600});
  chmod(destination,0o600);
  display('PASS: staging canonical BOX snapshot exported (no cloud writes)');
  display('Canonical revision: '+result.revision);
  display('Price-lookup entries: '+result.target.length);
  display('Condition review entries: '+result.review.length);
  display('Excluded opened/tape-cut entries: '+result.excluded.length);
  display('Private text file: '+destination);
  display('----- COPY TEXT FOR GROK BELOW -----');
  display(contents);
  return {revision:result.revision,text:contents,path:destination,
    targetCount:result.target.length,reviewCount:result.review.length};
}
async function main(args=process.argv.slice(2)) {
  if(args.length!==1 || args[0]!=='--export') {
    blocked('only --export is supported; no queue/write/retry mode');
  }
  checkProject();
  const { Firestore }=await import('@google-cloud/firestore');
  const db=new Firestore({projectId:PROJECT});
  const store=createFirestoreStore(db,DOCUMENT);
  return exportCurrentBoxes({store});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    const m=String(error?.message||'');
    console.error(m.startsWith('BLOCKED:')?m:'BLOCKED: private BOX export could not be verified');
    process.exitCode=2;
  });
}
