import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('V2 entry submit is single-flight and fail-closed',()=>{
  assert.match(source,/let entrySubmitting=false;/);
  assert.match(source,/if\(entrySubmitting\)return;entrySubmitting=true;/);
  assert.match(source,/finally\{entrySubmitting=false\}/);
  assert.match(source,/if\(v2ModeLocked\(\)&&!v2Connected\(\)\)\{entrySubmitting=false;setSyncStatus\('V2保存失敗/);
});

test('completed one-shot purchase preset is removed',()=>{
  assert.match(source,/const pendingPresets=\{\};/);
  assert.doesNotMatch(source,/コイキング M6a 165\/103/);
});

test('V2 permanent mode blocks local fallback',()=>{
  assert.match(source,/function v2ModeLocked\(\)\{return v2ReadOnly\|\|requiresVaultV2\(\)\|\|hasV2ReadOnly\(\)\|\|isV2WriteEnabled\(\)\}/);
  assert.match(source,/function assertWritable\(\)\{if\(v2ModeLocked\(\)\)throw new Error\('V2永続接続モードではローカル保存できません'\)\}/);
  assert.doesNotMatch(source,/disableV2ReadOnly\(\);disableV2Write\(\);clearSyncConfig\(\)/);
});
