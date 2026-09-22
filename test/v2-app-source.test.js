import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('V2 entry submit is single-flight and fail-closed',()=>{
  assert.match(source,/let entrySubmitting=false;/);
  assert.match(source,/if\(entrySubmitting\)return;entrySubmitting=true;/);
  assert.match(source,/finally\{entrySubmitting=false\}/);
  assert.match(source,/if\(hasV2ReadOnly\(\)&&!v2Connected\(\)\)throw new Error\('V2接続が完了していません。ローカル保存を停止しました'\)/);
});

test('completed one-shot purchase preset is removed',()=>{
  assert.match(source,/const pendingPresets=\{\};/);
  assert.doesNotMatch(source,/コイキング M6a 165\/103/);
});
