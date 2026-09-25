import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const patcher = new URL('../scripts/patch-cardrush-buyback.mjs', import.meta.url);
const source = new URL('../automation/Code.gs', import.meta.url);
test('deploy patches only the card matcher and preserves remote API code', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-cardrush-'));
  try {
    const file = path.join(dir, 'Code.js');
    fs.writeFileSync(file, 'function doPost() { return "remote API"; }\nfunction findCardrushBuyback_() { return null; }\nfunction fetchAltemaBuyback_() { return "remote fallback"; }\nfunction onOpen() { return 1; }\n');
    const run = () => spawnSync(process.execPath, [patcher.pathname, file, source.pathname], {encoding:'utf8'});
    assert.equal(run().status, 0);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /function doPost\(\) \{ return "remote API"/);
    assert.match(content, /function onOpen\(\) \{ return 1/);
    assert.match(content, /モンスターボールミラー/);
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally {fs.rmSync(dir, {recursive:true, force:true})}
});
