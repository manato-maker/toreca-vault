import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../automation/V2Automation.gs', import.meta.url), 'utf8');
for (const [status, receiptStatus, result, expectedReview] of [
  ['当選', '未受取', '落選', 1],
  ['購入済', '未受取', '落選', 1],
  ['購入済', '受取済み', '落選', 1],
  ['落選', '対象外', '当選', 1],
  ['応募済', '対象外', '当選', 0]
]) {
  const lottery = { id: 'application-1', status, receiptStatus, receivedDate: receiptStatus === '受取済み' ? '2026-09-22' : '', resultDate: '2026-09-20' };
  const state = { lotteries: [lottery] };
  const message = { getDate: () => new Date(), getId: () => 'mail-1', getSubject: () => '抽選結果', getPlainBody: () => 'ポケモン 当選 落選' };
  const context = vm.createContext({
    CARD_WORDS: /ポケモン/, RESULT_WORDS: /抽選結果/, APPLICATION_WORDS: /申込完了/,
    GmailApp: { search: () => [{ getMessages: () => [message] }] },
    matchLottery_: () => ({ kind: 'match', item: lottery }),
    parseResult_: () => ({ status: result, resultDate: '2026-09-24' }),
    tv2Mutate_: (_kind, fn) => fn(state)
  });
  vm.runInContext(source.slice(0, source.indexOf('function tv2Mutate_(')), context);
  const output = vm.runInContext('runTv2LotteryAuto()', context);
  assert.equal(output.report.review, expectedReview, `${status} / ${result}`);
  assert.equal(lottery.status, expectedReview ? status : '当選');
  assert.equal(lottery.receiptStatus, expectedReview ? receiptStatus : '未受取');
  assert.equal(lottery.resultDate, expectedReview ? '2026-09-20' : '2026-09-24');
  assert.equal(state.automation.health.gmailStatus, expectedReview ? 'review' : 'ok');
}
