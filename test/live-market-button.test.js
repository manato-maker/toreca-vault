import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
test('market refresh is server-side only',()=>{
 assert.doesNotMatch(html,/data-refresh-live-market/);
 assert.match(html,/毎日13:30以降に1回/);
 assert.match(html,/カードラッシュ→トレトク/);
 assert.doesNotMatch(app,/MARKET_REFRESH_URL|postMarketControlVerified_|submitMarketControlForm_/);
});
