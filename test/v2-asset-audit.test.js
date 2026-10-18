import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=()=>readFile(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const normalize=value=>String(value||'').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();

test('2026-10-18 asset audit is read-only and returns only reconciliation-relevant records',async()=>{
 const text=await source();
 const start=text.indexOf('function tv2AssetAuditView_(state,requestId,filters)');
 const end=text.indexOf('\nfunction runTv2AssetAudit',start);
 assert.ok(start>=0&&end>start);
 const context={normalize_:(s)=>normalize(s)};
 vm.runInNewContext(text.slice(start,end)+';this.audit=tv2AssetAuditView_;',context);
 const view=context.audit({revision:77,lastMutationId:'m1',
  transactions:[
   {id:'target-tx',type:'purchase',product:'Product Alpha',store:'Store Alpha',date:'2020-01-01',quantity:2,price:10,total:20},
   {id:'unrelated',type:'purchase',product:'Product Beta',store:'Store Alpha',date:'2020-01-01',quantity:1,price:1,total:1},
   {id:'opening',type:'opening',product:'Product Alpha Pack',store:'Store Beta',date:'2020-01-01',quantity:10,price:0,total:0}
  ],
  inventoryLots:[
   {id:'set-lot',product:'Product Alpha',category:'BOX',quantity:2,store:'Store Alpha'},
   {id:'single-lot',product:'Card Gamma',category:'カード',set:'SET X-17',quantity:1},
   {id:'pack-lot',product:'Product Alpha Pack',category:'パック',quantity:0}
  ],
  lotteries:[{id:'target-lottery',title:'Product Alpha',store:'Store Alpha',status:'当選',receiptStatus:'未受取'}]
 },'asset-audit-test',{storeIncludes:['Store Alpha','Store Beta'],productIncludes:['Product Alpha','Card Gamma','SET X-17']});
 assert.equal(view.readOnly,true);
 assert.equal(view.revision,77);
 assert.deepEqual(JSON.parse(JSON.stringify(view.transactions.map(x=>x.id))),['target-tx','opening']);
 assert.deepEqual(JSON.parse(JSON.stringify(view.lots.map(x=>x.id))),['set-lot','single-lot','pack-lot']);
 assert.deepEqual(JSON.parse(JSON.stringify(view.lotteries.map(x=>x.id))),['target-lottery']);
 assert.deepEqual(JSON.parse(JSON.stringify(view.openedSingles.map(x=>x.id))),['single-lot']);
 assert.deepEqual(JSON.parse(JSON.stringify(view.packs.map(x=>x.id))),['pack-lot']);
 assert.equal(view.counts.transactions,2);
});

test('audit queue command is separately allowlisted and does not call a mutation API',async()=>{
 const text=await source();
 const start=text.indexOf('function runTv2AssetAudit(command)');
 const end=text.indexOf('\nfunction tv2ProcessChatTradeDrafts_',start);
 const audit=text.slice(start,end);
 const queue=text.slice(end,text.indexOf('\n}',end)+2);
 assert.match(audit,/tv2Load_\(\)/);
 assert.match(audit,/tv2AssetAuditView_/);
 assert.doesNotMatch(audit,/tv2Mutate_/);
 assert.match(queue,/asset-audit/);
});

test('audit saves a private result draft and stops if that result already exists',async()=>{
 const text=await source();
 const helperStart=text.indexOf('function tv2AssetAuditView_(state,requestId,filters)');
 const helperEnd=text.indexOf('\nfunction runTv2AssetAudit',helperStart);
 const runnerStart=helperEnd+1;
 const runnerEnd=text.indexOf('\nfunction tv2ProcessChatTradeDrafts_',runnerStart);
 const created=[];
 let drafts=[];
 const context={
  normalize_:(s)=>normalize(s),
  tv2Load_:()=>({payload:{},revision:77}),
  Session:{getEffectiveUser:()=>({getEmail:()=> 'private@example.test'})},
  GmailApp:{getDrafts:()=>drafts,createDraft:(...args)=>created.push(args)}
 };
 vm.runInNewContext(text.slice(helperStart,helperEnd)+'\n'+text.slice(runnerStart,runnerEnd)+';this.runAudit=runTv2AssetAudit;',context);
 const command={requestId:'asset-audit-test',filters:{storeIncludes:['Store Alpha'],productIncludes:['Product Alpha']}};
 const result=context.runAudit(command);
 assert.equal(result.ok,true);
 assert.equal(result.readOnly,true);
 assert.equal(result.revision,77);
 assert.equal(created.length,1);
 assert.equal(created[0][0],'private@example.test');
 assert.match(created[0][1],/asset-audit-test/);
 drafts=[{getMessage:()=>({getSubject:()=>created[0][1]})}];
 assert.throws(()=>context.runAudit(command),/既にあります/);
 assert.equal(created.length,1);
});

test('failed private commands remain queued and produce one private diagnostic draft',async()=>{
 const text=await source();
 const start=text.indexOf('function tv2ProcessChatTradeDrafts_(){');
 const end=text.indexOf('\nfunction tv2HandleMarketRefreshWeb_',start);
 const drafts=[],created=[];
 const commandMessage={getSubject:()=> '[Toreca Vault Command]',getPlainBody:()=>JSON.stringify({type:'asset-audit',requestId:'asset-audit-test'})};
 const commandDraft={getMessage:()=>commandMessage,deleteDraft:()=>{throw new Error('failed command must remain queued')}};
 drafts.push(commandDraft);
 const context={
  GmailApp:{getDrafts:()=>drafts,createDraft:(to,subject,body)=>{created.push({to,subject,body});drafts.push({getMessage:()=>({getSubject:()=>subject})})}},
  Session:{getEffectiveUser:()=>({getEmail:()=> 'private@example.test'})},
  runTv2AssetAudit:()=>{throw new Error('expected revision check failed')}
 };
 vm.runInNewContext(text.slice(start,end)+';this.process=tv2ProcessChatTradeDrafts_;',context);
 const result=context.process();
 assert.equal(result.length,1);
 assert.equal(result[0].ok,false);
 assert.equal(drafts.includes(commandDraft),true);
 assert.equal(created.length,1);
 assert.match(created[0].subject,/asset-audit-test/);
 assert.match(created[0].body,/expected revision check failed/);
 context.process();
 assert.equal(created.length,1,'retries do not create duplicate diagnostic drafts');
});
