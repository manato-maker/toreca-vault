import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const patcher = new URL('../scripts/patch-cardrush-buyback.mjs', import.meta.url);
const source = new URL('../automation/Code.gs', import.meta.url);
test('deploy patches canonical market and lottery parsers while preserving remote API code', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-cardrush-'));
  try {
    const file = path.join(dir, 'Code.js');
    const canonical = fs.readFileSync(source, 'utf8');
    const range = (start, end) => canonical.slice(canonical.indexOf(start), canonical.indexOf(end, canonical.indexOf(start) + start.length));
    const fixture = [
      range('const RESULT_WORDS =', 'function installTorecaVaultAutomation()'),
      'function installTorecaVaultAutomation() { return 1; }\n',
      'function runTorecaVaultLotterySync() { return 1; }\n',
      range('function matchLottery_(', 'function sendReport_('),
      'function sendReport_() { return 1; }\n',
      'function runTorecaVaultMarketSync() { return 1; }\n',
      'function doPost() { return "remote API"; }\n',
      'function findCardrushBuyback_() { return null; }\n',
      'function fetchAltemaBuyback_() { return "remote fallback"; }\n',
      'function onOpen() { return 1; }\n',
      'function syncSealedMarketCandidates_() { return 1; }\n',
      'function refreshSealedMarketCandidates_() { return "old feed"; }\n'
    ].join('');
    fs.writeFileSync(file, fixture);
    const run = () => spawnSync(process.execPath, [patcher.pathname, file, source.pathname], {encoding:'utf8'});
    assert.equal(run().status, 0);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /function doPost\(\) \{ return "remote API"/);
    assert.match(content, /function onOpen\(\) \{ return 1/);
    assert.match(content, /モンスターボールミラー/);
    assert.match(content, /当選されました/);
    assert.match(content, /注文番号/);
    assert.match(content, /遊戯王/);
    assert.equal(run().status, 0);
    const second = fs.readFileSync(file, 'utf8');
    assert.match(second, /tv2ParseSealedFeed_/);
    assert.match(second, /sourceUrl/);
  } finally {fs.rmSync(dir, {recursive:true, force:true})}
});
