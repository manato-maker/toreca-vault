import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('production automation has one server-side entry point',async()=>{
  const s=await read('automation/V2Automation.gs');
  assert.match(s,/function runTv2Automation\(\)/);
  assert.match(s,/everyMinutes\(15\)/);
  assert.match(s,/everyMinutes\(30\)/);
  assert.match(s,/atHour\(12\)\.nearMinute\(30\)\.everyDays\(1\)/);
  assert.match(s,/atHour\(19\)\.nearMinute\(0\)\.everyDays\(1\)/);
  assert.match(s,/hour>13\|\|\(hour===13&&minute>=30\)/);
  assert.match(s,/lastScheduledMarketDate/);
});

test('Gmail command and lottery processing remain idempotent and review-safe',async()=>{
  const s=await read('automation/V2Automation.gs');
  assert.match(s,/tv2ProcessChatTradeDrafts_/);
  assert.match(s,/gmailMessageIds/);
  assert.match(s,/gmailNeedsReview/);
  assert.match(s,/tv2DeleteDraft_\(draft\)/);
});

test('single market sources are Cardrush then Toretoku only',async()=>{
  const s=await read('automation/V2Automation.gs');
  const start=s.indexOf("let result=rows&&name?tv2TryMarketSource_('カードラッシュCSV'");
  const end=s.indexOf("if(!result||!Number.isFinite(result.price)||result.price<=0)",start);
  const chain=s.slice(start,end);
  assert.match(chain,/fetchCardrushMediaBuyback_/);
  assert.match(chain,/fetchToretokuBuyback_/);
  assert.doesNotMatch(chain,/fetchToresiaBuyback_|fetchGamepediaBuyback_|fetchAltemaBuyback_|fetchCardValueBuyback_/);
  assert.match(s,/marketLookupName/);
  assert.match(s,/user-screenshot/);
});

test('15-minute command queue is isolated from Gmail and lottery polling',async()=>{
  const s=await read('automation/V2Automation.gs');
  const queue=s.slice(s.indexOf('function runTv2Automation(){'),s.indexOf('function runTv2LotteryGmailCheck(){'));
  const gmail=s.slice(s.indexOf('function tv2RunGmailWithBackoff_(options){'),s.indexOf('function runTv2LotteryAuto(options){'));
  assert.match(queue,/tv2ProcessSheetCommandQueue_\\(\\)/);
  assert.doesNotMatch(queue,/GmailApp|tv2GetDrafts_|tv2ProcessChatTradeDrafts_|runTv2LotteryAuto/);
  assert.match(gmail,/runTv2LotteryAuto\\(options\\)/);
  assert.match(gmail,/tv2EnforceRetailPricePolicy_/);
  assert.match(gmail,/resultOnly/);
});
test('queue authorization check is read-only and validates the exact queue headers',async()=>{
  const s=await read('automation/V2Automation.gs');
  const start=s.indexOf('function tv2AuthorizeCommandQueue()');
  const end=s.indexOf('function tv2DispatchQueuedCommand_',start);
  const check=s.slice(start,end);
  assert.match(check,/SpreadsheetApp\\.openById/);
  assert.match(check,/readOnly:true/);
  assert.match(check,/queue headers do not match/);
  assert.doesNotMatch(check,/setValues|appendRow|deleteRow|deleteSheet|tv2Mutate_/);
});
test('sheet queue commands use stable request ids and safely cover chat operations',async()=>{
  const s=await read('automation/V2Automation.gs');
  assert.match(s,/function tv2ProcessSheetCommandQueue_\\(\\)/);
  assert.match(s,/function runTv2ChatOpenPacks\\(command\\)/);
  assert.match(s,/function runTv2ChatLotteryResultExact\\(command\\)/);
  assert.match(s,/function runTv2ChatLotteryReceipt\\(command\\)/);
  assert.match(s,/chatLotteryResultIds/);
  assert.match(s,/chatLotteryReceiptIds/);
  assert.match(s,/V2正本に開封対象パック在庫がありません/);
  assert.match(s,/受取対象の抽選が複数一致しました/);
});

test('Gmail draft queue uses one shared draft snapshot per Apps Script execution',async()=>{
  const files=await Promise.all(['automation/V2Automation.gs','automation/RetailPricePolicy.gs','automation/Code.gs'].map(read));
  const all=files.join('\n');
  assert.equal((all.match(/GmailApp\.getDrafts\(\)/g)||[]).length,1);
  assert.equal((all.match(/GmailApp\.createDraft\.apply\(/g)||[]).length,1);
  assert.equal((all.match(/\.deleteDraft\(\)/g)||[]).length,1);
  assert.match(all,/function tv2GetDrafts_\(\)/);
  assert.match(all,/function tv2CreateDraft_\(\)/);
  assert.match(all,/function tv2DeleteDraft_\(draft\)/);
});
