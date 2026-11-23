import test from 'node:test';
import assert from 'node:assert/strict';
import { exactStagingJobs, pauseExactStagingJobs } from '../scripts/staging-op18-pause-workers.js';

const PROJECT='project-8ff0bbc4-675d-4596-a8a';
const REGION='asia-northeast1';
const URL='https://toreca-vault-staging-235108293761.asia-northeast1.run.app';
function job(name,path,state='ENABLED') {
  return {name:'projects/'+PROJECT+'/locations/'+REGION+'/jobs/'+name,state,
    httpTarget:{uri:URL+path,httpMethod:'POST',
      oidcToken:{serviceAccountEmail:'staging@example.iam.gserviceaccount.com'}}};
}
function fixtures() {
  return {
    serviceUrl:URL,
    jobs:[
      job('toreca-vault-staging-intake','/internal/worker/sheets-intake'),
      job('toreca-vault-staging-commands','/internal/worker/commands'),
      job('production-do-not-touch','/internal/worker/production')
    ]
  };
}
test('only exact two worker targets in exact staging project are identified',()=>{
  const selected=exactStagingJobs(fixtures());
  assert.equal(selected.intake.shortName,'toreca-vault-staging-intake');
  assert.equal(selected.commands.shortName,'toreca-vault-staging-commands');
  assert.equal(Object.keys(selected).length,2);
});
test('fail closed with duplicate, missing, wrong project, changed URI, missing OIDC and wrong name',()=>{
  const examples=[
    x=>x.jobs.push({...x.jobs[0]}),
    x=>x.jobs.splice(1,1),
    x=>x.jobs[1].name='projects/production-project/locations/'+REGION+'/jobs/toreca-vault-staging-commands',
    x=>x.jobs[1].httpTarget.uri=URL+'/internal/worker/command',
    x=>delete x.jobs[1].httpTarget.oidcToken,
    x=>x.jobs[0].name='projects/'+PROJECT+'/locations/'+REGION+'/jobs/intake-other',
    x=>x.jobs[0].state='UNSUPPORTED',
    x=>x.serviceUrl='https://production-other.run.app'
  ];
  for(const change of examples) {
    const input=fixtures();change(input);
    assert.throws(()=>exactStagingJobs(input),/BLOCKED/);
  }
});
test('pause only exact two staging worker jobs, commands before intake',()=>{
  const calls=[];
  const result=pauseExactStagingJobs({...fixtures(),exec:(_program,args)=>{
    calls.push(args);return 'OK';
  }});
  assert.deepEqual(calls.map(args=>args[3]),['toreca-vault-staging-commands','toreca-vault-staging-intake']);
  assert.ok(calls.every(args=>args[4]==='--project'&&args[5]===PROJECT&&args[6]==='--location'&&args[7]===REGION));
  assert.equal(result.commands.state,'PAUSED');
  assert.equal(result.intake.state,'PAUSED');
  assert.equal(calls.some(args=>args.join(' ').includes('production')),false);
});
test('pause is idempotent for exact already paused job and never touches others',()=>{
  const input=fixtures();input.jobs[1].state='PAUSED';
  const calls=[];
  pauseExactStagingJobs({...input,exec:(_program,args)=>{calls.push(args);return 'OK'}});
  assert.deepEqual(calls.map(args=>args[3]),['toreca-vault-staging-intake']);
  const allPaused=fixtures();allPaused.jobs[0].state='PAUSED';allPaused.jobs[1].state='PAUSED';
  const other=[];
  pauseExactStagingJobs({...allPaused,exec:(_program,args)=>{other.push(args);return 'OK'}});
  assert.deepEqual(other,[]);
});
