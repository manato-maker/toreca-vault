import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeLotteryRetailer,
  extractExplicitLotteryApplicationId,
  resolveChatLotteryIdentity,
  resolveGmailLotteryIdentity
} from '../src/lottery-event-intake.js';

test('Chat text and transient Gmail fields produce the same application identity and key', () => {
  const chat = resolveChatLotteryIdentity({
    kind: 'application',
    retailer: 'ポケセンオンライン',
    reportText: '抽選申込番号：ＡＢ－１２３'
  });
  const gmail = resolveGmailLotteryIdentity({
    kind: 'application',
    subject: 'ポケモンセンターオンライン 抽選申込完了',
    text: 'お申し込み番号: AB-123'
  });
  assert.deepEqual(chat, gmail);
  assert.deepEqual(chat.businessEventIdentity, {
    retailerKey: 'pokemoncenter-online', applicationId: 'AB-123'
  });
  assert.match(chat.businessEventKey, /^lottery:v1:[a-f0-9]{64}$/);
});

test('separate lottery event kinds produce different keys for the same application ID', () => {
  const application = resolveChatLotteryIdentity({ kind: 'application', retailer: 'ヤマダデンキ', applicationId: 'Y-204' });
  const result = resolveChatLotteryIdentity({ kind: 'result', retailer: 'ヤマダ電機', applicationId: 'Y-204' });
  assert.equal(application.status, 'ready');
  assert.equal(result.status, 'ready');
  assert.notEqual(application.businessEventKey, result.businessEventKey);
});

test('unknown retailer and missing, conflicting, or ambiguous IDs route to review without a key', () => {
  const cases = [
    resolveChatLotteryIdentity({ kind: 'application', retailer: 'unknown shop', applicationId: 'A-1' }),
    resolveChatLotteryIdentity({ kind: 'application', retailer: 'ヤマダデンキ', reportText: '応募しました。' }),
    resolveChatLotteryIdentity({ kind: 'application', retailer: 'ヤマダデンキ', applicationId: 'A-1', reportText: '申込番号: B-2' }),
    resolveGmailLotteryIdentity({ kind: 'application', subject: 'カードボックス オーサカ店 申込完了', text: '応募番号: A-1 / 受付番号: B-2' }),
    resolveGmailLotteryIdentity({ kind: 'application', subject: 'カードボックス オーサカ店 / ヤマダデンキ', text: '申込番号: A-1' })
  ];
  for (const result of cases) {
    assert.equal(result.status, 'review');
    assert.equal('businessEventKey' in result, false);
  }
});

test('product codes without an explicit ID label are never treated as application IDs', () => {
  assert.deepEqual(extractExplicitLotteryApplicationId('商品コード OP-18 を購入'), {
    status: 'review', reasonCode: 'lottery-application-id-missing'
  });
});

test('retailer aliases normalize only through the explicit supported map', () => {
  assert.deepEqual(canonicalizeLotteryRetailer(' カードボックス　オーサカ店 '), {
    status: 'ready', retailerKey: 'cardbox-osaka'
  });
  assert.equal(canonicalizeLotteryRetailer('ポケモンカード公式').status, 'review');
});
