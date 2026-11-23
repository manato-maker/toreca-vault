#!/usr/bin/env node
/**
 * Staging-only job isolation for the exact original OP-18 #64 CAS repair.
 * --status is read only; --pause pauses ONLY the exact Intake and command
 * worker Scheduler jobs of the verified staging service.
 * Does not trigger, replay, resume, edit Sheets, or edit Firestore.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifiedStagingConfiguration } from './staging-scoped-opening-once.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const REGION = 'asia-northeast1';
const SERVICE = 'toreca-vault-staging';
const INTAKE_NAME = 'toreca-vault-staging-intake';

function blocked(message) { throw new Error('BLOCKED: ' + message); }
function runGcloud(args, exec = execFileSync) {
  try {
    return String(exec('gcloud', args, {
      encoding: 'utf8', timeout: 45000, maxBuffer: 2_000_000
    })).trim();
  } catch { blocked('staging Scheduler metadata or IAM permission unavailable'); }
}
function runJson(args, exec) {
  let value;
  try { value = JSON.parse(runGcloud(args, exec)); }
  catch { blocked('Scheduler JSON metadata invalid'); }
  return value;
}

/** Pure guard: never infer a Scheduler job by its name alone. */
export function exactStagingJobs({ serviceUrl, jobs } = {}) {
  if (typeof serviceUrl !== 'string'
    || !serviceUrl.startsWith('https://' + SERVICE + '-')
    || !serviceUrl.endsWith('.run.app')
    || !Array.isArray(jobs)) {
    blocked('staging service URL or Scheduler listing invalid');
  }
  const required = {
    intake: serviceUrl + '/internal/worker/sheets-intake',
    commands: serviceUrl + '/internal/worker/commands'
  };
  const selected = {};
  for (const [kind, uri] of Object.entries(required)) {
    const matching = jobs.filter(job => job?.httpTarget?.uri === uri);
    if (matching.length !== 1) blocked(kind + ' target not uniquely found');
    const job = matching[0];
    const name = String(job.name || '');
    const prefix = 'projects/' + PROJECT + '/locations/' + REGION + '/jobs/';
    if (!name.startsWith(prefix) || !/^[a-z][a-z0-9-]{2,90}$/.test(name.slice(prefix.length))
      || job.httpTarget.httpMethod !== 'POST'
      || !['ENABLED','PAUSED'].includes(job.state)
      || !job.httpTarget.oidcToken?.serviceAccountEmail?.endsWith('.gserviceaccount.com')) {
      blocked(kind + ' Scheduler target/identity/state differs from expected staging metadata');
    }
    if (kind === 'intake' && name !== prefix + INTAKE_NAME) {
      blocked('staging Intake job name changed');
    }
    selected[kind] = { name, shortName: name.slice(prefix.length), state: job.state };
  }
  if (selected.intake.name === selected.commands.name) blocked('worker and intake jobs unexpectedly identical');
  return selected;
}

export function pauseExactStagingJobs({ serviceUrl, jobs, exec = execFileSync } = {}) {
  const selected = exactStagingJobs({ serviceUrl, jobs });
  // Pause commands first: never allow it to claim the unsourced row 64 while
  // the staging operator is setting up its scoped CAS.
  for (const kind of ['commands','intake']) {
    const current = selected[kind];
    if (current.state === 'PAUSED') continue;
    runGcloud(['scheduler','jobs','pause',current.shortName,
      '--project',PROJECT,'--location',REGION], exec);
    current.state = 'PAUSED';
  }
  return selected;
}

export function verifiedCurrentJobs(exec = execFileSync) {
  verifiedStagingConfiguration({ apply: false });
  const service = runJson(['run','services','describe',SERVICE,
    '--project',PROJECT,'--region',REGION,'--format=json'], exec);
  const jobs = runJson(['scheduler','jobs','list',
    '--project',PROJECT,'--location',REGION,'--format=json'], exec);
  return { serviceUrl: String(service?.status?.url || ''), jobs };
}

function main(args=process.argv.slice(2)) {
  if (args.length !== 1 || !['--status','--pause'].includes(args[0])) {
    blocked('usage: --status OR --pause (no resume/retry supported)');
  }
  const { serviceUrl,jobs } = verifiedCurrentJobs();
  const chosen=exactStagingJobs({ serviceUrl,jobs });
  console.log('Verified staging workers:');
  for (const kind of ['commands','intake']) {
    console.log(kind+': '+chosen[kind].shortName+' ('+chosen[kind].state+')');
  }
  if(args[0]==='--status') {
    console.log('READ ONLY: no Scheduler changes or data writes');
    return;
  }
  // Re-query the exact listing immediately before writes, rather than using
  // an earlier --status result.
  const before=verifiedCurrentJobs();
  pauseExactStagingJobs(before);
  const after=verifiedCurrentJobs();
  const confirmed=exactStagingJobs(after);
  if(confirmed.commands.state!=='PAUSED' || confirmed.intake.state!=='PAUSED') {
    blocked('a job did not remain PAUSED; do not apply a repair');
  }
  console.log('PASS: both exact staging workers PAUSED; no production jobs modified');
  console.log('NOTICE: do not resume until canonical, queue and Intake receipt have been reconciled');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {main();}catch(error) {
    const msg=String(error?.message||'');
    console.error(msg.startsWith('BLOCKED:')?msg:'BLOCKED: staging pause guard failed; no repair attempted');
    process.exitCode=2;
  }
}
