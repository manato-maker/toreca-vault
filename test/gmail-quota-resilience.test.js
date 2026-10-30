const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','automation','V2Automation.gs'),'utf8');
const helperStart=source.indexOf('var TV2_GMAIL_DRAFT_CACHE_=null;');
const helperEnd=source.indexOf('function tv2CreateDraft_()',helperStart);
const wrappersStart=source.indexOf('function tv2RunGmailWithBackoff_(');
const wrappersEnd=source.indexOf('function runTv2LotteryAuto(',wrappersStart);
assert.ok(helperStart>=0&&helperEnd>helperStart);
assert.ok(wrappersStart>=0&&wrappersEnd>wrappersStart);

function makeContext(){
 const values=new Map();
 const cache={get:key=>values.get(key)||null,put:(key,value)=>values.set(key,String(value))};
 const context={CacheService:{getScriptCache:()=>cache},GmailApp:{getDrafts:()=>[]}};
 vm.createContext(context);
 vm.runInContext(source.slice(helperStart,helperEnd),context);
 vm.runInContext(source.slice(wrappersStart,wrappersEnd),context);
 return{context,values};
}

test('draft message metadata is fetched once per draft in a run',()=>{
 const {context}=makeContext();
 const calls={message:0,subject:0,body:0};
 const draft={getMessage(){calls.message++;return{
  getSubject(){calls.subject++;return'[Toreca Vault Command]'},
  getPlainBody(){calls.body++;return'{"type":"purchase"}'}
 }}};
 assert.equal(context.tv2DraftSubject_(draft),'[Toreca Vault Command]');
 assert.equal(context.tv2DraftSubject_(draft),'[Toreca Vault Command]');
 assert.equal(context.tv2DraftPlainBody_(draft),'{"type":"purchase"}');
 assert.equal(context.tv2DraftPlainBody_(draft),'{"type":"purchase"}');
 assert.deepEqual(calls,{message:1,subject:1,body:1});
});

test('Gmail daily quota activates bounded backoff and skips later polls',()=>{
 let calls=0;
 const {context}=makeContext();
 context.runTv2LotteryAuto=()=>{calls++;throw new Error('Service invoked too many times for one day: gmail')};
 const first=context.tv2RunGmailWithBackoff_({skipScheduleEnsure:true});
 const second=context.tv2RunGmailWithBackoff_({skipScheduleEnsure:true});
 assert.equal(first.reason,'gmail-quota');
 assert.equal(second.reason,'gmail-quota-backoff');
 assert.equal(calls,1);
 assert.ok(Number(first.retryAfter)>Date.now());
});

test('quota errors are recognized without logging their original message',()=>{
 const {context}=makeContext();
 assert.equal(context.tv2GmailQuotaError_(new Error('Service invoked too many times for one day: gmail')),true);
 assert.equal(context.tv2GmailQuotaError_(new Error('V2 network failure')),false);
});
