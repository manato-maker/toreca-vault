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
 const end=text.indexOf('\nfunction runTv2AssetReconcile',start);
 const queueStart=text.indexOf('function tv2ProcessChatTradeDrafts_()',end);
 const queueEnd=text.indexOf('\nfunction tv2HandleMarketRefreshWeb_',queueStart);
 const audit=text.slice(start,end);
 const queue=text.slice(queueStart,queueEnd);
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

test('asset reconciliation adds purchases, consumes opened packs, allocates cost once, and is idempotent',async()=>{
 const text=await source();
 const start=text.indexOf('function runTv2AssetReconcile(command)');
 const end=text.indexOf('\nfunction tv2ProcessChatTradeDrafts_',start);
 let state={revision:5,transactions:[],inventoryLots:[],lotteries:[{id:'win-1',status:'当選',receiptStatus:'未受取',owner:'本人',resultDate:'2026-10-15'}],auditLog:[]};
 const created=[],drafts=[];
 const context={
  normalize_:(s)=>normalize(s),
  tv2RetailPriceInfo_:(product,category)=>category==='パック'?{price:360,basis:'希望小売価格',source:'official'}:null,
  tv2Mutate_:(kind,fn)=>{const next=structuredClone(state),result=fn(next)||{};if(result.changed!==false){next.revision++;state=next;}return{revision:state.revision,...result};},
  tv2Load_:()=>({payload:structuredClone(state),revision:state.revision}),
  Session:{getEffectiveUser:()=>({getEmail:()=> 'private@example.test'})},
  GmailApp:{getDrafts:()=>drafts,createDraft:(to,subject,body)=>{created.push({to,subject,body});drafts.push({getMessage:()=>({getSubject:()=>subject})})}}
 };
 vm.runInNewContext(text.slice(start,end)+';this.reconcile=runTv2AssetReconcile;',context);
 const command={requestId:'asset-reconcile-test',expectedRevision:5,purchases:[{id:'buy-pack-1',product:'30th CELEBRATION pack',store:'Store A',date:'2026-10-18',category:'パック',condition:'',quantity:10,price:360,actualPaidTotal:3456},{id:'buy-set-self',product:'Card set alpha',store:'Same Store',date:'2026-10-17',category:'BOX',condition:'未開封',quantity:1,price:10800,sourceLotteryId:'win-self'},{id:'buy-set-wife',product:'Card set alpha',store:'Same Store',date:'2026-10-17',category:'BOX',condition:'未開封',quantity:1,price:10800,sourceLotteryId:'win-wife'}],openings:[{id:'open-pack-1',product:'30th CELEBRATION pack',sourceLotId:'lot-buy-pack-1',quantity:10,date:'2026-10-18',store:'Store A',derivedLots:[{id:'card-1',product:'Jirachi ex SAR',category:'カード',set:'M6a 132/103',quantity:1,unitCost:1800},{id:'card-2',product:'Gengar 30th gold',category:'カード',set:'M6a 150/103',quantity:1,unitCost:1800}]}],lotteryUpdates:[{id:'win-1',expected:{status:'当選',receiptStatus:'未受取',owner:'本人',resultDate:'2026-10-15'},updates:{status:'購入済',receiptStatus:'受取済み',receivedDate:'2026-10-18',receiptAmount:3600,receiptPaidAmount:3456,receiptQuantity:10}}]};
 const result=context.reconcile(command);
 assert.equal(result.ok,true);
 assert.equal(state.revision,6);
 assert.equal(state.transactions.find(x=>x.id==='buy-pack-1').actualPaidTotal,3456);
 assert.equal(state.transactions.filter(x=>x.store==='Same Store').length,2,'two separately lottery-linked set receipts in one command are not mistaken for prior duplicates');
 assert.equal(state.transactions.find(x=>x.id==='open-pack-1').acquisitionCost,3600);
 assert.equal(state.inventoryLots.some(x=>x.id==='lot-buy-pack-1'),false);
 assert.equal(state.inventoryLots.filter(x=>x.category==='カード').reduce((n,x)=>n+x.quantity*x.unitCost,0),3600);
 assert.equal(state.lotteries[0].receiptStatus,'受取済み');
 const repeated=context.reconcile(command);
 assert.equal(repeated.mutation.duplicate,true);
 assert.equal(state.revision,6,'idempotent retry does not increment the canonical revision');
 assert.equal(created.length,1,'idempotent retry reuses the single result draft');
 assert.throws(()=>context.reconcile({...command,expectedRevision:7}),/revisionより正本revisionが古い/);
});

test('scoped one-shot runner processes only asset-reconcile drafts and returns no purchase details',async()=>{
 const text=await source();
 const start=text.indexOf('function runTv2AssetReconcileOnce(){');
 const end=text.indexOf('\nfunction tv2ProcessChatTradeDrafts_',start);
 const drafts=[],deleted=[],messages=[];
 const makeDraft=(subject,body)=>({getMessage:()=>({getSubject:()=>subject,getPlainBody:()=>body}),deleteDraft:()=>deleted.push(subject)});
 const sale=makeDraft('[Toreca Vault Command]',JSON.stringify({type:'sale',requestId:'old-sale'}));
 const reconcile=makeDraft('[Toreca Vault Command]',JSON.stringify({type:'asset-reconcile',requestId:'private-request'}));
 drafts.push(sale,reconcile);
 const context={
  GmailApp:{getDrafts:()=>drafts,createDraft:(to,subject,body)=>{messages.push({to,subject,body});}},
  Session:{getEffectiveUser:()=>({getEmail:()=> 'private@example.test'})},
  runTv2AssetReconcile:()=>({ok:true,requestId:'private-request',revision:99,purchases:[{store:'private store',total:1}]})
 };
 vm.runInNewContext(text.slice(start,end)+';this.runOnce=runTv2AssetReconcileOnce;',context);
 const result=context.runOnce();
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:true,processed:1,revision:99});
 assert.deepEqual(deleted,['[Toreca Vault Command]']);
 assert.equal(messages.length,0);
 assert.equal(JSON.stringify(result).includes('private store'),false);
 assert.equal(sale.getMessage().getPlainBody().includes('old-sale'),true);
});

test('scoped runner fails closed when multiple reconciliation drafts are queued',async()=>{
 const text=await source();
 const start=text.indexOf('function runTv2AssetReconcileOnce(){');
 const end=text.indexOf('\nfunction tv2ProcessChatTradeDrafts_',start);
 const mk=id=>({getMessage:()=>({getSubject:()=> '[Toreca Vault Command]',getPlainBody:()=>JSON.stringify({type:'asset-reconcile',requestId:id})}),deleteDraft:()=>{throw new Error('must not delete')}});
 const context={GmailApp:{getDrafts:()=>[mk('asset-reconcile-one'),mk('asset-reconcile-two')]}};
 vm.runInNewContext(text.slice(start,end)+';this.runOnce=runTv2AssetReconcileOnce;',context);
 assert.throws(()=>context.runOnce(),/複数あるため安全停止/);
});

test('scoped runner workflow waits for a successful Apps Script deploy',async()=>{
 const {readFile}=await import('node:fs/promises');
 const workflow=await readFile(new URL('../.github/workflows/run-tv2-asset-reconcile-once.yml',import.meta.url),'utf8');
 assert.match(workflow,/workflow_run:/);
 assert.match(workflow,/Apps Script Automation Deploy/);
 assert.match(workflow,/conclusion == 'success'/);
 assert.match(workflow,/clasp run runTv2AssetReconcileOnce/);
 assert.doesNotMatch(workflow,/runTv2Automation/);
});
