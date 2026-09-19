import test from'node:test';import assert from'node:assert/strict';import{loadV2}from'../v2/api-client.js';
test('loadV2 keeps token out of URL and sends it in POST body',async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return{json:async()=>({ok:true,payload:{},revision:1,lastMutationId:'m'})}};
 await loadV2('https://example.test/exec','secret-token');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://example.test/exec');assert.equal(calls[0].options.method,'POST');
 const body=JSON.parse(calls[0].options.body);assert.deepEqual(body,{action:'load',token:'secret-token'});assert.doesNotMatch(calls[0].url,/secret-token|token=/);
});
