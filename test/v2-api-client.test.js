import test from'node:test';import assert from'node:assert/strict';import{loadV2}from'../v2/api-client.js';

test('loadV2 keeps token out of the normal read URL and sends it in POST body',async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return{text:async()=>JSON.stringify({ok:true,payload:{schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]},revision:1,lastMutationId:'m'})}};
 await loadV2('https://example.test/exec','secret-token');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://example.test/exec');assert.equal(calls[0].options.method,'POST');
 const body=JSON.parse(calls[0].options.body);assert.deepEqual(body,{action:'load',token:'secret-token'});assert.doesNotMatch(calls[0].url,/secret-token|token=/);
});

test('loadV2 falls back to read-only GET when Apps Script returns HTML for POST',async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)return{text:async()=>'<html><body>temporary Google page</body></html>'};
  return{text:async()=>JSON.stringify({ok:true,payload:{schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]},revision:2,lastMutationId:'n'})};
 };
 const result=await loadV2('https://example.test/exec','secret-token');
 assert.equal(result.revision,2);
 assert.equal(calls.length,2);
 assert.equal(calls[0].options.method,'POST');
 assert.equal(calls[1].options.method,'GET');
 assert.match(calls[1].url,/action=load/);
 assert.match(calls[1].url,/token=secret-token/);
});
