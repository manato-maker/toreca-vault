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


test('production triggers fail closed until both writers are accepted',async()=>{
 const s=await read();
 assert.match(s,/tv2AutoAssertProductionReady_\(\)/);
 assert.match(s,/function tv2AutoLotteryWriterReady_\(\) \{ return false; \}/);
 assert.match(s,/function tv2AutoMarketWriterReady_\(\) \{ return false; \}/);
 const install=s.slice(s.indexOf('function installTorecaVaultV2Automation()'),s.indexOf('function uninstallTorecaVaultV2Automation()'));
 assert.match(install,/tv2AutoAssertProductionReady_\(\)/);
});


test('automation readiness inspection is read-only and reports trigger handlers',async()=>{
 const s=await read();
 const start=s.indexOf('function inspectTorecaVaultV2Automation()');
 const end=s.indexOf('function runTorecaVaultV2LotterySync()',start);
 assert.ok(start >= 0 && end > start);
 const inspect=s.slice(start,end);
 assert.match(inspect,/readOnly:\s*true/);
 assert.match(inspect,/productionReady:/);
 assert.match(inspect,/v2TriggerHandlers:/);
 assert.doesNotMatch(inspect,/setContent\s*\(/);
 assert.doesNotMatch(inspect,/newTrigger\s*\(/);
 assert.doesNotMatch(inspect,/deleteTrigger\s*\(/);
});
