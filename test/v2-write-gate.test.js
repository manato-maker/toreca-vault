import test from'node:test';import assert from'node:assert/strict';
const mem=new Map();globalThis.sessionStorage={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
const gate=await import('../v2/write-gate.js');
test('V2 writes are disabled by default',()=>{gate.disableV2Write();assert.equal(gate.isV2WriteEnabled(),false);assert.throws(()=>gate.assertV2WriteEnabled(),/有効化/)});
test('wrong phrase cannot enable V2 writes',()=>{gate.disableV2Write();assert.throws(()=>gate.enableV2WriteForSession('yes',1),/一致/);assert.equal(gate.isV2WriteEnabled(),false)});
test('invalid revision cannot enable V2 writes',()=>{gate.disableV2Write();assert.throws(()=>gate.enableV2WriteForSession('V2書込を有効化','x'),/revision/);assert.equal(gate.isV2WriteEnabled(),false)});
test('gate is bound to the verified revision',()=>{gate.disableV2Write();assert.equal(gate.enableV2WriteForSession('V2書込を有効化',7),true);assert.equal(gate.assertV2WriteEnabled(7),true);assert.throws(()=>gate.assertV2WriteEnabled(8),/revision/);gate.disableV2Write();assert.equal(gate.isV2WriteEnabled(),false)});
