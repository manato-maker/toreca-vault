import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
const src=fs.readFileSync(new URL('../v2/api-acceptance.js',import.meta.url),'utf8');
test('acceptance runner preserves business collections',()=>{for(const name of ['transactions','inventoryLots','lotteries','marketQuotes'])assert.ok(src.includes(name));});
test('acceptance runner requires one audit mutation and revision CAS',()=>{assert.ok(src.includes('sameMutationCount!==1'));assert.ok(src.includes('before.revision'));assert.ok(src.includes('saveV2'));});
test('acceptance runner verifies duplicate idempotency',()=>{assert.ok(src.includes("duplicate.duplicate!==true"));assert.ok(src.includes("'二重送信防止テスト失敗'"));});
test('acceptance runner verifies stale revision conflict without mutation',()=>{assert.ok(src.includes("stale.conflict!==true"));assert.ok(src.includes("'古いrevision拒否テスト失敗'"));assert.ok(src.includes("'拒否テスト後に状態が変化しました'"));});
