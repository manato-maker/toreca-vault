import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const source=fs.readFileSync(new URL('../v2/apps-script/Code.gs',import.meta.url),'utf8');
test('v2 API does not fetch/eval remote code',()=>{assert.doesNotMatch(source,/UrlFetchApp|\beval\s*\(/)});
test('v2 API uses lock, revision and reread verification',()=>{assert.match(source,/LockService\.getScriptLock/);assert.match(source,/revision conflict/);assert.match(source,/var reread = tv2Read_\(\)/);assert.match(source,/post-write verification failed/)});
test('v2 API uses dedicated v2 file property',()=>{assert.match(source,/TV_V2_DATA_FILE_ID/);assert.doesNotMatch(source,/TV_DATA_FILE_ID['"]/)});