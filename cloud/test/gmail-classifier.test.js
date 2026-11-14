import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLotteryMessage } from '../src/gmail-classifier.js';

test('classifies result mail by the subject and supports focused result scans', () => {
  assert.deepEqual(classifyLotteryMessage({ subject: 'ポケモンカード 抽選結果のお知らせ' }), { kind: 'result' });
  assert.deepEqual(classifyLotteryMessage({ subject: '落選のお知らせ', text: 'ポケモンカード' }), { kind: 'result' });
  assert.deepEqual(classifyLotteryMessage({ subject: 'ポケモンカード 応募完了', resultOnly: true }), { kind: 'ignore', reason: 'not-result' });
});

test('classifies application completion using the Apps Script subject and body rules', () => {
  assert.deepEqual(classifyLotteryMessage({ subject: 'ポケモンカード 抽選申込完了' }), { kind: 'application' });
  assert.deepEqual(classifyLotteryMessage({ subject: '受付のお知らせ', text: 'ポケモンカード 抽選販売へのお申込み受付が完了しました' }), { kind: 'application' });
});

test('ignores unrelated, non-card, and inconclusive mail without preserving message fields', () => {
  assert.deepEqual(classifyLotteryMessage({ subject: '応募完了', text: 'カードゲームの抽選応募' }), { kind: 'ignore', reason: 'not-card-related' });
  assert.deepEqual(classifyLotteryMessage({ subject: 'ポケモンカード 発送のお知らせ' }), { kind: 'ignore', reason: 'not-lottery-mail' });
  const output = JSON.stringify(classifyLotteryMessage({ subject: 'secret subject', text: 'secret body' }));
  assert.equal(output.includes('secret'), false);
});
