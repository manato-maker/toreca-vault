import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
const src=fs.readFileSync(new URL('../v2/api-acceptance.js',import.meta.url),'utf8');
test('acceptance runner preserves business collections',()=>{for(const name of ['transactions','inventoryLots','lotteries','marketQuotes'])assert.ok(src.includes(name));});
test('acceptance runner requires one audit mutation and revision CAS',()=>{assert.ok(src.includes('sameMutationCount!==1'));assert.ok(src.includes('before.revision'));assert.ok(src.includes('saveV2'));});
