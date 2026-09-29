import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
test('V2 transient read failures retry automatically without local fallback',()=>{
 assert.match(app,/function scheduleV2Reconnect_\(\)/);
 assert.match(app,/setTimeout\(\(\)=>\{v2ReconnectTimer=null;connectV2Remote_\(\)\},delay\)/);
 assert.match(app,/V2一時切断/);
 assert.match(app,/state=emptyState\(\);render\(\)/);
 assert.match(app,/addEventListener\('online'/);
 assert.match(app,/visibilitychange/);
});
