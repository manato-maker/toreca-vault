import test from'node:test';import assert from'node:assert/strict';
const local=new Map(),session=new Map();
globalThis.localStorage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
globalThis.sessionStorage={getItem:k=>session.get(k)??null,setItem:(k,v)=>session.set(k,String(v)),removeItem:k=>session.delete(k)};
const sync=await import('../v2/browser-sync.js');
const url='https://script.google.com/macros/s/test-deployment-id/exec',token='12345678901234567890123456789012';
const reset=()=>{local.clear();session.clear()};
test('recovers V2 config from earlier handoff storage keys',()=>{reset();local.set('tv-v2-sync-endpoint',url);local.set('tv-v2-sync-token',token);const c=sync.getVaultV2Config();assert.deepEqual(c,{url,token});assert.equal(local.get('toreca-vault:v2:required'),'1');assert.deepEqual(JSON.parse(local.get('toreca-vault:v2:sync')),{url,token})});
test('set mirrors compatibility keys and explicit clear removes every V2 credential key',()=>{reset();sync.setVaultV2Config(url,token);assert.equal(local.get('tv-v2-sync-endpoint'),url);assert.equal(local.get('tv-v2-sync-token'),token);sync.clearVaultV2Config();for(const k of ['toreca-vault:v2:sync','toreca-vault:v2:required','tv-v2-sync-endpoint','tv-v2-sync-token'])assert.equal(local.has(k),false);assert.equal(session.has('toreca-vault:v2:token'),false)});
