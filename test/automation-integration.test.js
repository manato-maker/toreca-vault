import assert from'node:assert/strict';import fs from'node:fs';
const v2=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
for(const re of [
 /newTrigger\(handler\)\.timeBased\(\)\.everyMinutes\(15\)/,
 /hour>13\|\|\(hour===13&&minute>=30\)/,
 /lastScheduledMarketDate/,
 /fetchCardrushMediaBuyback_/,
 /cardrush-toretoku-v6/,
 /fetchToretokuBuyback_/,
 /marketLookupName/,
 /free-public-feed-only/,
 /parsed\.status==='落選'&&item\.receiptStatus!=='受取済み'/
])assert.match(v2,re);
assert.match(code,/function runTorecaVaultLotterySync\(\) \{[\s\S]*tv2EnsureSimpleAutomationSchedule_\(true\);[\s\S]*runTv2Automation\(\)/);
assert.match(code,/function runTorecaVaultMarketSync\(\) \{[\s\S]*tv2EnsureSimpleAutomationSchedule_\(true\);[\s\S]*runTv2Automation\(\)/);
console.log('automation integration: ok');
