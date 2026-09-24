import assert from'node:assert/strict';import fs from'node:fs';const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const must=[
/newTrigger\('runTorecaVaultLotterySync'\).*atHour\(12\).*nearMinute\(30\)/s,
/newTrigger\('runTorecaVaultLotterySync'\).*atHour\(19\).*nearMinute\(0\)/s,
/newTrigger\('runTorecaVaultMarketSync'\).*atHour\(13\).*nearMinute\(0\)/s,
/refreshSealedMarketCandidates_\(root\.data, date, reviews\)/,
/syncSealedMarketCandidates_\(root\.data, date, reviews\)/,
/SEALED_MARKET_STORES = new Set\(\['買取ミミ','AMTAF','アリウム'\]\)/,
/String\(q\.condition\|\|''\)\.trim\(\)===condition/,
/q\.verified===true/,
/!q\.imageDerived \|\| \['official','google'\]/,
/item\.marketFresh=false; item\.marketTrend='stale'/,
/parsed\.status === '落選' && item\.receiptStatus !== '受取済み'/,
/title: resultDate \? cleanLotteryTitle_\(title\) : '詳細不明'/,
/store: cleanStoreName_\(store\)/
];for(const re of must)assert.match(code,re);
assert.ok(code.indexOf('refreshSealedMarketCandidates_(root.data, date, reviews)')<code.indexOf('syncSealedMarketCandidates_(root.data, date, reviews)'),'feed must run before policy');
console.log('automation integration: ok');
