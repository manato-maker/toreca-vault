import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserState} from '../v2/browser-sync.js';

test('browser adapter accepts canonical v2 state',()=>{
 assert.equal(validateBrowserState({schemaVersion:2,transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[]}),true);
});
test('browser adapter rejects v1 wrapper',()=>{
 assert.throws(()=>validateBrowserState({schemaVersion:1,data:{}}),/V2/);
});
