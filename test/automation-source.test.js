import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('production automation has one server-side entry point',async()=>{
  const s=await read('automation/V2Automation.gs');
  assert.match(s,/function runTv2Automation\(\)/);
  assert.match(s,/everyMinutes\(15\)/);
  assert.match(s,/hour>13\|\|\(hour===13&&minute>=30\)/);
  assert.match(s,/lastScheduledMarketDate/);
});

test('Gmail command and lottery processing remain idempotent and review-safe',async()=>{
  const s=await read('automation/V2Automation.gs');
  assert.match(s,/tv2ProcessChatTradeDrafts_/);
  assert.match(s,/gmailMessageIds/);
  assert.match(s,/gmailNeedsReview/);
  assert.match(s,/draft\.deleteDraft\(\)/);
});

test('single market sources are Cardrush then Toretoku only',async()=>{
  const s=await read('automation/V2Automation.gs');
  const start=s.indexOf("let result=rows&&name?tv2TryMarketSource_('カードラッシュCSV'");
  const end=s.indexOf("if(!result||!Number.isFinite(result.price)||result.price<=0)",start);
  const chain=s.slice(start,end);
  assert.match(chain,/fetchCardrushMediaBuyback_/);
  assert.match(chain,/fetchToretokuBuyback_/);
  assert.doesNotMatch(chain,/fetchToresiaBuyback_|fetchGamepediaBuyback_|fetchAltemaBuyback_|fetchCardValueBuyback_/);
});
