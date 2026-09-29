import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
test('V2 reconnects automatically and refreshes whenever the app resumes',()=>{
 assert.match(app,/function scheduleV2Reconnect_\(\)/);
 assert.match(app,/setTimeout\(\(\)=>\{v2ReconnectTimer=null;connectV2Remote_\(\)\},delay\)/);
 assert.match(app,/V2一時切断/);
 assert.match(app,/addEventListener\('online',\(\)=>connectV2Remote_\(\)\)/);
 assert.match(app,/addEventListener\('pageshow',\(\)=>connectV2Remote_\(\)\)/);
 assert.match(app,/visibilitychange/);
 assert.match(app,/最新データ確認まで資産額は表示しません/);
});
