import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
test('market button requests live refresh endpoint',()=>{assert.match(html,/data-refresh-live-market/);assert.match(html,/最新相場を取得・更新/);assert.match(app,/postMarketControlVerified_\('refresh-market-v2'/);assert.match(app,/MARKET_REFRESH_URL/);assert.match(app,/最新相場を取得中/);assert.match(app,/submitMarketControlForm_/);assert.match(app,/form\.method='POST'/);assert.match(app,/postMarketControlVerified_/);});
