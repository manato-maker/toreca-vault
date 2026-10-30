import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');

test('installer creates separated queue, Gmail, and result triggers plus a self-removing bootstrap',()=>{
  assert.match(source,/newTrigger\('runTv2Automation'\)\.timeBased\(\)\.everyMinutes\(15\)\.create\(\)/);
  assert.match(source,/newTrigger\('runTv2LotteryGmailCheck'\)\.timeBased\(\)\.everyMinutes\(30\)\.create\(\)/);
  assert.match(source,/newTrigger\('runTv2LotteryResultCheck1230'\)\.timeBased\(\)\.atHour\(12\)\.nearMinute\(30\)\.everyDays\(1\)\.create\(\)/);
  assert.match(source,/newTrigger\('runTv2LotteryResultCheck1900'\)\.timeBased\(\)\.atHour\(19\)\.nearMinute\(0\)\.everyDays\(1\)\.create\(\)/);
  assert.match(source,/newTrigger\('runTv2AutomationBootstrap_'\)\.timeBased\(\)\.after\(15000\)\.create\(\)/);
  assert.match(source,/function tv2AutomationStatus\(\)/);
  assert.match(source,/function runTv2AutomationBootstrap_\(\)/);
});
