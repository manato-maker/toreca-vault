import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailLotteryCommandDraft } from '../src/gmail-lottery-command-builder.js';
import { createLotteryBusinessEventKey } from '../src/business-event-identity.js';

const retailerAliases = { 'トレカショップA': 'shop-a' };

test('builds an application command only from explicit labels and uses the shared event identity', () => {
  const draft = buildGmailLotteryCommandDraft({
    kind: 'application', subject: 'ポケモンカード 抽選申込完了',
    text: '応募ID: APP-123\n店舗名: トレカショップA\n商品名: 商品A\n応募日: 2026-11-08\n応募者: 本人',
    retailerAliases
  });
  assert.deepEqual(draft.command, { type: 'lottery', title: '商品A', store: 'トレカショップA', status: '応募済', applicationDate: '2026-11-08', owner: '本人' });
  assert.deepEqual(draft.businessEventIdentity, { retailerKey: 'shop-a', applicationId: 'APP-123' });
  assert.equal(createLotteryBusinessEventKey({ kind: 'application', ...draft.businessEventIdentity }).businessEventKey.startsWith('lottery:v1:'), true);
  assert.equal(JSON.stringify(draft).includes('応募日:'), false);
});

test('builds a result command only from an explicit status/date and exact retailer alias', () => {
  const draft = buildGmailLotteryCommandDraft({
    kind: 'result', subject: '抽選結果のお知らせ',
    text: '応募番号: APP-123\n販売店: トレカショップA\n対象商品: 商品A\n抽選結果: 当選\n結果日: 2026-11-08\n申込者: 本人',
    retailerAliases
  });
  assert.deepEqual(draft.command, { type: 'lottery-result-exact', title: '商品A', store: 'トレカショップA', status: '当選', resultDate: '2026-11-08', owner: '本人' });
  assert.deepEqual(draft.businessEventIdentity, { retailerKey: 'shop-a', applicationId: 'APP-123' });
});

test('missing, ambiguous, unknown, or malformed labelled facts return review without a command', () => {
  const base = '応募ID: APP-123\n店舗名: トレカショップA\n商品名: 商品A\n応募日: 2026-11-08';
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: base.replace('応募ID: APP-123\n', ''), retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: `${base}\n応募ID: APP-999`, retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: base.replace('トレカショップA', '未知の店'), retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: base.replace('2026-11-08', '2026-02-31'), retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: `${base}\n商品名: 別商品`, retailerAliases }), null);
  const unlabelled = buildGmailLotteryCommandDraft({ kind: 'application', text: `${base}\n本文に書かれた商品Aの応募ID: APP-999`, retailerAliases });
  assert.equal(unlabelled.businessEventIdentity.applicationId, 'APP-123');
});

test('unlabelled numbers, sender-like context, and oversized message data are never inferred', () => {
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: 'ポケモンカード 応募番号 APP-123', retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', subject: '抽選申込完了', text: 'APP-123', retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'application', text: 'x'.repeat(600_000), retailerAliases }), null);
  assert.equal(buildGmailLotteryCommandDraft({ kind: 'receipt', text: '不明', retailerAliases }), null);
});
