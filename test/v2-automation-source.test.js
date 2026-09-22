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
 assert.match(s,/writer-locked/);
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


test('one-step read-only acceptance keeps production locked and trigger-free',async()=>{
 const s=await read();
 const start=s.indexOf('function acceptTorecaVaultV2ReadOnly()');
 const end=s.indexOf('function inspectTorecaVaultV2Automation()',start);
 assert.ok(start >= 0 && end > start);
 const accept=s.slice(start,end);
 assert.match(accept,/previewTorecaVaultV2Automation\(\)/);
 assert.match(accept,/inspectTorecaVaultV2Automation\(\)/);
 assert.match(accept,/production writers must remain locked/);
 assert.match(accept,/V2 triggers must not exist during read-only acceptance/);
 assert.match(accept,/accepted:\s*true/);
 assert.doesNotMatch(accept,/setContent\s*\(/);
 assert.doesNotMatch(accept,/newTrigger\s*\(/);
});


test('Gmail lottery integration remains read-only and privacy-minimal',async()=>{
 const s=await read();
 assert.match(s,/function previewTorecaVaultV2LotteryMailParsing\(\)/);
 assert.match(s,/tv2AutoParseLivePocket_/);
 assert.match(s,/tv2AutoParseToysRUs_/);
 assert.match(s,/tv2AutoParseGoogleForm_/);
 const start=s.indexOf('function previewTorecaVaultV2LotteryMailParsing()');
 const end=s.indexOf('function runTorecaVaultV2LotterySync()',start);
 assert.ok(start >= 0 && end > start);
 const preview=s.slice(start,end);
 assert.match(preview,/GmailApp\.search/);
 assert.match(preview,/readOnly:true/);
 assert.doesNotMatch(preview,/setContent\s*\(/);
 assert.doesNotMatch(preview,/tv2AutoSaveVerified_\s*\(/);
 assert.doesNotMatch(preview,/createDraft|sendEmail|moveToTrash|markRead/);
 assert.doesNotMatch(preview,/会員番号|顧客ID|お名前/);
});


test('single deployment acceptance includes read-only Gmail parser preview',async()=>{
 const s=await read();
 const start=s.indexOf('function acceptTorecaVaultV2Deployment()');
 const end=s.indexOf('function inspectTorecaVaultV2Automation()',start);
 assert.ok(start >= 0 && end > start);
 const accept=s.slice(start,end);
 assert.match(accept,/previewTorecaVaultV2LotteryMailParsing\(\)/);
 assert.match(accept,/lotteryPreview:/);
 assert.doesNotMatch(accept,/tv2AutoSaveVerified_\s*\(/);
 assert.doesNotMatch(accept,/newTrigger\s*\(/);
});


test('verified automation save rejects stale REAL state before writing',async()=>{
 const s=await read();
 const start=s.indexOf('function tv2AutoSaveVerified_(before, next)');
 const end=s.indexOf('function tv2AutoRead_()',start);
 assert.ok(start >= 0 && end > start);
 const save=s.slice(start,end);
 assert.match(save,/var current = tv2AutoRead_\(\)/);
 assert.match(save,/stale automation write/);
 assert.match(save,/automation base changed before save/);
 const firstWrite=save.indexOf('file.setContent(out)');
 assert.ok(firstWrite > save.indexOf('stale automation write'));
 assert.ok(firstWrite > save.indexOf('automation base changed before save'));
});


test('REAL save preflight is read-only and reports whether a verified save would be allowed',async()=>{
 const s=await read();
 const start=s.indexOf('function tv2AutoPreviewVerifiedSave_(before, next)');
 const end=s.indexOf('function tv2AutoSaveVerified_(before, next)',start);
 assert.ok(start >= 0 && end > start);
 const preview=s.slice(start,end);
 assert.match(preview,/tv2AutoRead_\(\)/);
 assert.match(preview,/readOnly:true/);
 assert.match(preview,/sameBase:/);
 assert.match(preview,/nextValid:/);
 assert.match(preview,/wouldWrite:/);
 assert.doesNotMatch(preview,/setContent\s*\(/);
 assert.doesNotMatch(preview,/tv2AutoSaveVerified_\s*\(/);
});


test('lottery production writer is implemented but hard-locked and verified before save',async()=>{
 const s=await read();
 const start=s.indexOf('function runTorecaVaultV2LotterySync()');
 const end=s.indexOf('function previewTorecaVaultV2Automation()',start);
 assert.ok(start >= 0 && end > start);
 const run=s.slice(start,end);
 assert.match(run,/if \(!tv2AutoLotteryWriterReady_\(\)\) return tv2AutoRecordHealthOnly_/);
 assert.match(run,/tv2AutoCollectLotteryInputs_\(\)/);
 assert.match(run,/review-required/);
 assert.match(run,/tv2AutoPreviewVerifiedSave_\(before, next\)/);
 assert.match(run,/tv2AutoSaveVerified_\(before, next\)/);
 assert.match(s,/function tv2AutoLotteryWriterReady_\(\) \{ return false; \}/);
});
