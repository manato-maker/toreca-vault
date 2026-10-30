import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const start=source.indexOf('function tv2SetCommandQueueRow_(');
const end=source.indexOf('function runTv2ChatOpenPacks(',start);
assert.ok(start>=0&&end>start);
const queueSource=source.slice(start,end);

function setup(rows,dispatch){
 const sheet={
  getLastRow:()=>rows.length,
  getRange(row,col,numRows,numCols){
   return{
    getValues(){return rows.slice(row-1,row-1+numRows).map(r=>r.slice(col-1,col-1+numCols))},
    setValues(matrix){matrix.forEach((values,i)=>{for(let j=0;j<values.length;j++)rows[row-1+i][col-1+j]=values[j]})}
   };
  }
 };
 const context={
  TV2_COMMAND_QUEUE_SHEET_ID_:'sheet-id',
  TV2_COMMAND_QUEUE_TAB_:'Queue',
  TV2_COMMAND_QUEUE_BATCH_SIZE_:5,
  TV2_COMMAND_QUEUE_STALE_MS_:30*60*1000,
  TV2_COMMAND_QUEUE_ALLOWED_TYPES_:['purchase','sale','lottery','lottery-bulk','open-packs','lottery-result-exact','lottery-receipt','pokemoncenter-spouse-result','repair-receipt-sale'],
  SpreadsheetApp:{openById:id=>{assert.equal(id,'sheet-id');return{getSheetByName:name=>name==='Queue'?sheet:null}},flush(){}},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  tv2DispatchQueuedCommand_:dispatch
 };
 vm.createContext(context);
 vm.runInContext(queueSource,context);
 return{context,rows};
}
function queueRow(requestId,payload,status='pending',attempts=0,processedAt=''){
 return[requestId,JSON.stringify(payload),status,attempts,'2026-10-31T00:00:00.000Z',processedAt,'',''];
}

test('pending Sheet command is claimed and completed once',()=>{
 let calls=0;
 const payload={type:'purchase',requestId:'purchase-1'};
 const {context,rows}=setup([['requestId','payloadJson','status','attempts','createdAt','processedAt','result','error'],queueRow('purchase-1',payload)],()=>{calls++;return{duplicate:false,changed:true}});
 const first=context.tv2ProcessSheetCommandQueue_();
 const second=context.tv2ProcessSheetCommandQueue_();
 assert.equal(first.processed,1);
 assert.equal(rows[1][2],'done');
 assert.equal(Number(rows[1][3]),1);
 assert.equal(calls,1);
 assert.equal(second.processed,0);
});

test('request id mismatch is sent to review without dispatch',()=>{
 let calls=0;
 const payload={type:'sale',requestId:'different-id'};
 const {context,rows}=setup([['requestId','payloadJson','status','attempts','createdAt','processedAt','result','error'],queueRow('row-id',payload)],()=>{calls++;return{ok:true}});
 const result=context.tv2ProcessSheetCommandQueue_();
 assert.equal(result.processed,0);
 assert.equal(rows[1][2],'review');
 assert.match(rows[1][7],/requestId column and payload do not match/);
 assert.equal(calls,0);
});

test('stale processing command may retry with the same idempotent request id',()=>{
 let calls=0;
 const old=new Date(Date.now()-31*60*1000).toISOString();
 const payload={type:'lottery',requestId:'lottery-1'};
 const {context,rows}=setup([['requestId','payloadJson','status','attempts','createdAt','processedAt','result','error'],queueRow('lottery-1',payload,'processing',1,old)],()=>{calls++;return{duplicate:true,changed:false}});
 const result=context.tv2ProcessSheetCommandQueue_();
 assert.equal(result.processed,1);
 assert.equal(rows[1][2],'done');
 assert.equal(Number(rows[1][3]),2);
 assert.equal(calls,1);
});

test('same request id with conflicting payload is stopped for review',()=>{
 let calls=0;
 const p1={type:'purchase',requestId:'same-id',product:'A'};
 const p2={type:'purchase',requestId:'same-id',product:'B'};
 const {context,rows}=setup([
  ['requestId','payloadJson','status','attempts','createdAt','processedAt','result','error'],
  queueRow('same-id',p1,'done',1),
  queueRow('same-id',p2,'pending',0)
 ],()=>{calls++;return{ok:true}});
 context.tv2ProcessSheetCommandQueue_();
 assert.equal(rows[2][2],'review');
 assert.match(rows[2][7],/requestId payload collision/);
 assert.equal(calls,0);
});
