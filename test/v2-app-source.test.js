import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('V2 entry submit is single-flight and fail-closed',()=>{
  assert.match(source,/receiptSubmitting=false,entrySubmitting=false;/);
  assert.match(source,/if\(entrySubmitting\)return;entrySubmitting=true;/);
  assert.match(source,/finally\{entrySubmitting=false\}/);
  assert.match(source,/if\(v2ModeLocked\(\)&&!v2Connected\(\)\)\{entrySubmitting=false;setSyncStatus\('V2保存失敗/);
});

test('completed one-shot purchase preset is removed',()=>{
  assert.match(source,/const pendingPresets=\{\};/);
  assert.doesNotMatch(source,/コイキング M6a 165\/103/);
});

test('V2-only runtime blocks all local/V1 fallback',()=>{
  assert.match(source,/let state=emptyState\(\),remoteRevision='',receiptTargetId='',v2ReadOnly=true/);
  assert.match(source,/function v2ModeLocked\(\)\{return true\}/);
  assert.match(source,/function assertWritable\(\)\{throw new Error\('V2専用モードです。ローカル\/V1保存は使用しません'\)\}/);
  assert.doesNotMatch(source,/state=load\(\)/);
  assert.doesNotMatch(source,/syncPublishedMarket\(\)/);
  assert.doesNotMatch(source,/disableV2ReadOnly\(\);disableV2Write\(\);clearSyncConfig\(\)/);
});

test('receipt submit shows immediate progress and is single-flight',()=>{
  assert.match(source,/if\(receiptSubmitting\)return;receiptSubmitting=true;/);
  assert.match(source,/button\.textContent='V2へ保存中…'/);
  assert.match(source,/finally\{receiptSubmitting=false;/);
});

test('calendar prefers result date and falls back to application deadline only when result date is missing',()=>{
  assert.match(source,/if\(resultDate\)add\(resultDate,x,'結果','result'\);else if\(deadline\)add\(deadline,x,'応募締切（結果日未設定）','deadline'\)/);
  assert.doesNotMatch(source,/add\(\(x\.deadline\|\|''\)\.slice\(0,10\),x,'応募締切','deadline'\);add\(x\.resultDate,x,'結果','result'\)/);
});
