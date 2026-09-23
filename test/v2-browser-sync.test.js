import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserState,setVaultV2Config,getVaultV2Config,clearVaultV2Config} from '../v2/browser-sync.js';

test('browser adapter accepts canonical v2 state',()=>{
 assert.equal(validateBrowserState({schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]}),true);
});
test('browser adapter rejects v1 wrapper',()=>{
 assert.throws(()=>validateBrowserState({schemaVersion:1,data:{}}),/V2/);
});



test('V2 URL and token persist across browser sessions',()=>{const local=new Map(),session=new Map();global.localStorage={getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};global.sessionStorage={getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)};const url='https://script.google.com/macros/s/example/exec',token='abcdefghijklmnopqrstuvwxyz123456';setVaultV2Config(url,token);session.clear();assert.deepEqual(getVaultV2Config(),{url,token});clearVaultV2Config();assert.deepEqual(getVaultV2Config(),{url:'',token:''})});
