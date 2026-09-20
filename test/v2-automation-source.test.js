import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=()=>readFile(new URL('../v2/apps-script/Automation.gs',import.meta.url),'utf8');

test('V2 automation is isolated from V1 and has verified save safety',async()=>{
 const s=await read();
 assert.match(s,/TV_V2_DATA_FILE_ID/);
 assert.doesNotMatch(s,/TV_DATA_FILE_ID/);
 assert.match(s,/tv2AutoSaveVerified_/);
 assert.match(s,/post-save canonical verification failed/);
 assert.match(s,/rollback verification failed/);
});
test('V2 automation does not silently enable Gmail or market writes',async()=>{
 const s=await read();
 assert.match(s,/parser-not-enabled/);
 assert.match(s,/fetcher-not-enabled/);
 assert.match(s,/installTorecaVaultV2Automation/);
});


test('V2 automation exposes a read-only acceptance preview',async()=>{
 const s=await read();
 assert.match(s,/function previewTorecaVaultV2Automation\(\)/);
 assert.match(s,/readOnly:\s*true/);
 const start=s.indexOf('function previewTorecaVaultV2Automation()');
 const end=s.indexOf('function runTorecaVaultV2MarketSync()',start);
 const preview=s.slice(start,end);
 assert.doesNotMatch(preview,/setContent\s*\(/);
 assert.doesNotMatch(preview,/tv2AutoSaveVerified_\s*\(/);
});
