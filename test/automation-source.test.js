import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('抽選自動化の重要な公開関数を維持', async () => {
  const source = await read('automation/Code.gs');
  for (const name of ['installTorecaVaultAutomation', 'runTorecaVaultLotterySync', 'runTorecaVaultMarketSync']) {
    assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`), `${name} が見つかりません`);
  }
});

test('申込完了と要確認の安全策を維持', async () => {
  const source = await read('automation/Code.gs');
  assert.match(source, /APPLICATION_WORDS/);
  assert.match(source, /needsReview/);
  assert.match(source, /gmailMessageIds/);
});
