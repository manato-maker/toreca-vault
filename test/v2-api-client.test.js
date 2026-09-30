import test from'node:test';import assert from'node:assert/strict';import{loadV2}from'../v2/api-client.js';

test('loadV2 uses the lock-free read-only GET endpoint first',async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return{text:async()=>JSON.stringify({ok:true,payload:{schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]},revision:1,lastMutationId:'m'})}};
 await loadV2('https://example.test/exec','secret-token');
 assert.equal(calls.length,1);
 assert.equal(calls[0].options.method,'GET');
 assert.match(calls[0].url,/action=load/);
 assert.match(calls[0].url,/token=secret-token/);
});

test('loadV2 falls back to POST when read-only GET fails at the network layer',async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)throw new TypeError('Failed to fetch');
  return{text:async()=>JSON.stringify({ok:true,payload:{schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]},revision:2,lastMutationId:'n'})};
 };
 const result=await loadV2('https://example.test/exec','secret-token');
 assert.equal(result.revision,2);
 assert.equal(calls.length,2);
 assert.equal(calls[0].options.method,'GET');
 assert.equal(calls[1].options.method,'POST');
 assert.equal(calls[1].url,'https://example.test/exec');
 const body=JSON.parse(calls[1].options.body);
 assert.deepEqual(body,{action:'load',token:'secret-token'});
});
