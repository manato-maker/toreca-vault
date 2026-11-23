import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectCanonical } from '../scripts/staging-op18-canonical-inspect.js';

const hash = x => createHash('sha256').update(String(x)).digest('hex');
const norm = x => String(x).normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '');
const hashNorm = x => hash(norm(x));
const product = 'ONE PIECEカードゲーム ブースターパック 神の支配【OP-18】';
const date = '2026-11-22';
const rows = {
  FURUICHI: {requestId:'test:purchase:f',store:'Shop F'},
  BIC: {requestId:'test:purchase:b',store:'Shop B'},
  MINT: {requestId:'test:purchase:m',store:'Shop M'}
};
const saleReq = 'test:sale:m';
const openReq = 'test:opening:original';
const sources = Object.fromEntries(Object.entries(rows)
  .map(([k,v]) => [k, {idHash:hash(v.requestId),storeHash:hashNorm(v.store)}]));
const sale = {idHash:hash(saleReq),storeHash:hashNorm('Buyer S')};
function makeFixture({soldFrom='MINT', opening=false}={}) {
  const transactions = Object.values(rows).map(p=>({
    id:'chat-purchase-'+p.requestId,requestId:p.requestId,product,productKey:product,
    type:'purchase',category:'BOX',condition:'',quantity:1,price:5760,
    date,store:p.store
  }));
  const inventoryLots = Object.entries(rows).filter(([k])=>k!==soldFrom).map(([,p])=>({
    id:'chat-purchase-'+p.requestId+'-lot',
    requestId:p.requestId,sourceTransactionId:'chat-purchase-'+p.requestId,
    category:'BOX',product,productKey:product,quantity:1,unitCost:5760,
    acquiredAt:date,store:p.store
  }));
  transactions.push({
    id:'chat-sale-'+saleReq,requestId:saleReq,type:'sale',category:'BOX',
    product,productKey:product,date,quantity:1,price:9000,store:'Buyer S'
  });
  if(opening)transactions.push({
    id:'chat-opening-'+openReq,requestId:openReq,
    type:'opening',category:'BOX',product,productKey:product,quantity:2,date
  });
  return {revision:100,payload:{revision:100,transactions,inventoryLots}};
}
const options = {sources,sale,openingHash:hash(openReq)};

test('canonical-only scan identifies exactly the two target lots, never needs Sheets',()=>{
  const original=makeFixture();
  const untouched=structuredClone(original);
  const result=inspectCanonical(original,options);
  assert.equal(result.revision,100);
  assert.equal(result.sourceLots.FURUICHI,'present-and-matched');
  assert.equal(result.sourceLots.BIC,'present-and-matched');
  assert.equal(result.sourceLots.MINT,'missing');
  assert.equal(result.pattern,'exact-two-target-lots');
  assert.equal(result.opening,'not-recorded');
  assert.deepEqual(original,untouched);
});

test('canonical-only scan flags a plausible historical same-day FIFO misallocation',()=>{
  const result=inspectCanonical(makeFixture({soldFrom:'FURUICHI'}),options);
  assert.equal(result.sourceLots.FURUICHI,'missing');
  assert.equal(result.sourceLots.BIC,'present-and-matched');
  assert.equal(result.sourceLots.MINT,'present-and-matched');
  assert.equal(result.pattern,'possible-historical-FIFO-misattribution');
});

test('no inferred correction when missing both target lots or all three are present',()=>{
  const missing=makeFixture({soldFrom:'MINT'});
  missing.payload.inventoryLots=[];
  assert.equal(inspectCanonical(missing,options).pattern,'manual-review-required');
  const excess=makeFixture({soldFrom:'MINT'});
  excess.payload.inventoryLots.push({
    id:'chat-purchase-'+rows.MINT.requestId+'-lot',
    sourceTransactionId:'chat-purchase-'+rows.MINT.requestId,requestId:rows.MINT.requestId,
    product,productKey:product,category:'BOX',store:'Shop M',
    acquiredAt:date,quantity:1,unitCost:5760
  });
  assert.equal(inspectCanonical(excess,options).pattern,'manual-review-required');
});

test('canonical evidence must preserve original cost, store, date and purchase IDs',()=>{
  for(const mutate of [
    x=>x.payload.transactions[0].price=999,
    x=>x.payload.transactions[0].store='Shop X',
    x=>x.payload.transactions[0].quantity=2,
    x=>x.payload.transactions[0].requestId='other',
    x=>x.payload.inventoryLots[0].unitCost=200,
    x=>x.revision=101
  ]) {
    const value=makeFixture();
    mutate(value);
    assert.throws(()=>inspectCanonical(value,options),/BLOCKED/);
  }
});

test('already recorded original opening cannot be mistaken for a missing opening',()=>{
  const value=makeFixture({opening:true});
  const result=inspectCanonical(value,options);
  assert.equal(result.opening,'already-recorded');
  assert.equal(result.pattern,'already-opened-needs-receipt-verification');
});
