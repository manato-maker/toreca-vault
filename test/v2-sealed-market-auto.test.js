import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const cell=(shop,handle,price,source=handle)=>`<div class="cell"><a class="shop-link" href="https://x.com/${handle}">${shop}</a><span class="price yen">¥${price.toLocaleString()}</span><a class="src" href="https://x.com/${source}/status/123">出典</a></div>`;
const row=(condition,cells)=>`<div class="crow" data-cond="${condition}"><div class="cells">${cells.join('')}</div></div>`;
const card=(category,name,official,rows)=>`<div class="card" data-cat="${category}" data-name="${name}"><span class="official">${official}</span>${rows.join('')}</div>`;
const feed=`${card('box','MEGAドリームEX','ハイクラスパック 「MEGAドリームex」',[
  row('shrink',[cell('AMTAF','AMTAF_SHOP',12000),cell('買取ミミ','mimi_kaitori',11500),cell('KURO','kuro_tcg',20000)]),
  row('no_shrink',[cell('AMTAF','AMTAF_SHOP',11000)]),
  row('loose_pack',[cell('買取ミミ','mimi_kaitori',350)])
])}${card('other','MEGAドリームEX 限定セット','限定セット',[row('shrink',[cell('AMTAF','AMTAF_SHOP',100000)])])}<footer>掲載日 <b>2026-09-25</b> / スナップショット 2026-09-25 13:19:21</footer>`;
const state={inventoryLots:[
  {id:'b1',category:'BOX',product:'MEGAドリームex',condition:'あり',quantity:1},
  {id:'b2',category:'BOX',product:'MEGAドリームex',condition:'なし',quantity:1},
  {id:'p1',category:'パック',product:'MEGAドリームex',condition:'未開封',quantity:1},
  {id:'b3',category:'BOX',product:'MEGAドリームex',condition:'未開封',quantity:1}
],marketQuotes:[]};
const context=vm.createContext({
  tv2Mutate_:(_kind,fn)=>fn(state),TZ:'Asia/Tokyo',
  Utilities:{formatDate:()=> '2026-09-25'},
  UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>feed})},
  normalize_:s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'')
});
vm.runInContext(src.slice(0,src.indexOf('function tv2Mutate_(')),context);
const parsed=vm.runInContext('tv2ParseSealedFeed_',context)(feed,'2026-09-25');
assert.equal(parsed.products.length,1);
assert.equal(parsed.products[0].offers.shrink.length,2);
assert.equal(vm.runInContext('tv2ParseSealedFeed_',context)(feed,'2026-09-26').date,'2026-09-25');
const result=vm.runInContext('runTv2MarketAuto()',context);
assert.equal(result.report.updated,3);
assert.equal(result.report.review,1);
assert.deepEqual(state.marketQuotes.map(q=>q.price),[12000,11000,350]);
assert.match(state.marketQuotes[0].source,/https:\/\/x\.com\/AMTAF_SHOP\/status\/123/);
assert.equal(state.marketQuotes[1].condition,'なし');
assert.equal(state.marketQuotes[2].category,'パック');
state.marketQuotes[0].price=1000;
const unusual=vm.runInContext('runTv2MarketAuto()',context);
assert.equal(unusual.report.review,2);
assert.equal(state.marketQuotes[0].price,1000);
assert.equal(state.marketQuotes[0].fresh,false);
state.marketQuotes[0].price=12000;
const nextFeed=feed.replace('掲載日 <b>2026-09-25</b> / スナップショット 2026-09-25','掲載日 <b>2026-09-26</b> / スナップショット 2026-09-26').replace(cell('AMTAF','AMTAF_SHOP',12000),'').replace(cell('買取ミミ','mimi_kaitori',11500),cell('買取ミミ','mimi_kaitori',10500));
context.Utilities.formatDate=()=> '2026-09-26';
context.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>nextFeed});
vm.runInContext('runTv2MarketAuto()',context);
assert.equal(state.marketQuotes[0].price,12000,'missing shop retains its last observed quote');
assert.equal(state.marketQuotes[0].shopOffers['AMTAF'].date,'2026-09-25');
assert.equal(state.marketQuotes[0].shopOffers['買取ミミ'].price,10500);
assert.equal(state.marketQuotes[0].fresh,false,'older winning shop quote is marked stale');
const replaced=nextFeed.replace(cell('AMTAF','AMTAF_SHOP',12000),'').replace(cell('買取ミミ','mimi_kaitori',10500),cell('買取ミミ','mimi_kaitori',12500));
context.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>replaced});
vm.runInContext('runTv2MarketAuto()',context);
assert.equal(state.marketQuotes[0].price,12500,'newer quote for the same shop replaces its older quote');
