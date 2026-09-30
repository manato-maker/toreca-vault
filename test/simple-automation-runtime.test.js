import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const v2=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('automation uses one 15-minute server-side runner with one daily market window',()=>{
  assert.match(v2,/function runTv2Automation\(\)/);
  assert.match(v2,/newTrigger\(handler\)\.timeBased\(\)\.everyMinutes\(15\)/);
  assert.match(v2,/hour>13\|\|\(hour===13&&minute>=30\)/);
  assert.match(v2,/scheduled:true/);
  assert.match(v2,/lastScheduledMarketDate/);
});

test('single-card writes use Cardrush only',()=>{
  const start=v2.indexOf("let result=rows&&name?tv2TryMarketSource_('カードラッシュCSV'");
  const end=v2.indexOf("if(!result||!Number.isFinite(result.price)||result.price<=0)",start);
  assert.ok(start>=0&&end>start);
  const chain=v2.slice(start,end);
  assert.match(chain,/fetchCardrushMediaBuyback_/);
  assert.doesNotMatch(chain,/fetchToretokuBuyback_|fetchToresiaBuyback_|fetchGamepediaBuyback_|fetchAltemaBuyback_|fetchCardValueBuyback_/);
  assert.match(v2,/cardrush-only-v5/);
});

test('browser boot only reconnects and reads V2',()=>{
  const start=app.indexOf('async function bootRemote()');
  const end=app.indexOf("bootRemote();",start);
  const boot=app.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.doesNotMatch(boot,/processPendingCommandQueueOnBoot\(|ensureV2OnlyCutoverOnBoot\(|refreshMarketOnceOnBoot\(/);
});
