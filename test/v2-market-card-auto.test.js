import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const card={id:'card-1',category:'カード',product:'ピカチュウ 025/100',condition:'良品',quantity:1};
const uncertain={id:'card-2',category:'カード',product:'リザードン 006/100',condition:'傷あり',quantity:1};
const state={inventoryLots:[card,uncertain],marketQuotes:[]};
let fetches=0;
const context=vm.createContext({
  tv2Mutate_:(_kind,fn)=>fn(state),TZ:'Asia/Tokyo',
  Utilities:{formatDate:()=> '2026-09-25'},
  normalize_:x=>String(x||'').toLowerCase(),
  extractModel_:x=>(String(x).match(/\d{3}\/\d{3}/)||[])[0]||'',
  fetchCardrushRows_:()=>{fetches++;return [['ピカチュウ','025/100','1200']]},
  findCardrushBuyback_:(_rows,name,model)=>name==='ピカチュウ'&&model==='025/100'?{price:1200}:null
});
vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),context);
let result=vm.runInContext('runTv2MarketAuto()',context);
assert.equal(result.report.updated,1);
assert.equal(result.report.review,1);
assert.equal(state.marketQuotes.length,1);
assert.equal(state.marketQuotes[0].price,1200);
assert.equal(state.marketQuotes[0].source,'カードラッシュ');
result=vm.runInContext('runTv2MarketAuto()',context);
assert.equal(result.report.updated,0);
assert.equal(result.report.unchanged,1);
assert.equal(state.marketQuotes[0].history.length,1);
assert.equal(fetches,2);
const pikachuState={inventoryLots:[
 {id:'p1',category:'カード',product:'ピカチュウ',set:'PROMO 001/SV-P',condition:'良品',quantity:1},
 {id:'p2',category:'カード',product:'ピカチュウ',set:'MC 225/742',condition:'良品',quantity:1,identityNeedsReview:true},
 {id:'p3',category:'カード',product:'ピカチュウ',set:'SV2a 025/165',condition:'良品',quantity:1}
],marketQuotes:[]};
const reviewContext=vm.createContext({tv2Mutate_:(_kind,fn)=>fn(pikachuState),TZ:'Asia/Tokyo',Utilities:{formatDate:()=> '2026-09-25'},normalize_:x=>String(x||'').toLowerCase(),extractModel_:x=>(String(x).match(/\d{3}\/(?:\d{3}|SV-P)/)||[])[0]||'',fetchCardrushRows_:()=>[['ピカチュウ','001/SV-P','1000'],['ピカチュウ','025/165','2000']],findCardrushBuyback_:(_rows,_name,model)=>model==='001/SV-P'?{price:1000}:model==='025/165'?{price:2000}:null});
vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),reviewContext);
const reviewed=vm.runInContext('runTv2MarketAuto()',reviewContext);
assert.equal(reviewed.report.updated,2,'different lots with the same name are checked independently');
assert.equal(reviewed.report.review,1,'inferred identity must not receive an automatic quote');
assert.deepEqual(pikachuState.marketQuotes.map(q=>q.lotId),['p1','p3']);

const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
const matcher=code.slice(code.indexOf('function findCardrushBuyback_('),code.indexOf('function fetchAltemaBuyback_('));
const prices=vm.createContext({normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'')});
vm.runInContext(matcher,prices);
const rows=[['ピカチュウ(ミラー)','225/742','500'],['ピカチュウ','225/742','300'],['ピカチュウ(マスターボールミラー)','025/165','45000'],['ピカチュウ(モンスターボールミラー)','025/165','800'],['ピカチュウ','025/165','30'],['メガリザードンXex','223/193','2500'],['メガリザードンXex 加工エラー','223/193','50000']];
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','225/742','ミラー')?.price,500);
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165','モンスターボールミラー')?.price,800);
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165'),null,'number alone must not pick an arbitrary print');
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'メガリザードンXex','223/193','通常版')?.price,2500,'explicit normal print excludes error print');

{
  const fallbackState={inventoryLots:[{id:'f1',category:'カード',product:'ピカチュウ',set:'PROMO 001/SV-P',condition:'美品',quantity:1}],marketQuotes:[]};
  const fallbackContext=vm.createContext({
    tv2Mutate_:(_kind,fn)=>fn(fallbackState),TZ:'Asia/Tokyo',
    Utilities:{formatDate:()=> '2026-09-26'},
    normalize_:x=>String(x||'').toLowerCase(),
    extractModel_:x=>(String(x).match(/\d{3}\/(?:\d{3}|SV-P)/)||[])[0]||'',
    fetchCardrushRows_:()=>{throw new Error('feed down')},
    findCardrushBuyback_:()=>null,
    fetchCardrushMediaBuyback_:()=>null,
    fetchToretokuBuyback_:(name,set,model)=>name==='ピカチュウ'&&set==='PROMO 001/SV-P'&&model==='001/SV-P'?{price:3200,source:'トレトク買取'}:null,
    fetchToresiaBuyback_:()=>null,
    fetchGamepediaBuyback_:()=>null,
    fetchAltemaBuyback_:()=>null
  });
  vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),fallbackContext);
  const fallbackResult=vm.runInContext('runTv2MarketAuto()',fallbackContext);
  assert.equal(fallbackResult.report.cardUpdated,1,'cardrush fetch failure falls back to an exact official buyback result');
  assert.equal(fallbackState.marketQuotes[0].price,3200);
  assert.equal(fallbackState.marketQuotes[0].source,'トレトク買取');
}
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165','マスターボールミラー')?.price,45000);

{
  const start=code.indexOf('function tv2ToretokuNameMatches_('),end=code.indexOf('function fetchAltemaBuyback_(');
  const fn=code.slice(start,end);
  const html='self.__next_f.push([1,"items:[{\\\"name\\\":\\\"メガレックウザex\\\",\\\"itemCode\\\":\\\"x\\\",\\\"price\\\":1700,\\\"sellPrice\\\":2700,\\\"modelNumber\\\":\\\"M6 095/076\\\",\\\"imageUrl\\\":\\\"u\\\",\\\"rarity\\\":\\\"SR\\\"}]"])';
  const ctx=vm.createContext({
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    encodeURIComponent,
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>html})}
  });
  vm.runInContext(fn,ctx);
  const hit=vm.runInContext('fetchToretokuBuyback_',ctx)('メガレックウザex','M6 095/076','095/076','');
  assert.equal(hit?.price,1700,'Toretoku parser accepts one exact name + full set/number match');
  assert.equal(hit?.source,'トレトク買取');
}


{
  const v2=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
  const start=v2.indexOf('function tv2CardVariant_('),end=v2.indexOf('function tv2RepairKnownCardIdentities20260928_(');
  const ctx=vm.createContext({normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'')});
  vm.runInContext(v2.slice(start,end),ctx);
  assert.equal(vm.runInContext('tv2CardVariant_',ctx)({variant:'通常版',set:'M2a 223/193',product:'メガリザードンex'}),'通常版');
}

{
  const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
  const start=code.indexOf('function tv2ToretokuNameMatches_('),end=code.indexOf('function fetchAltemaBuyback_(');
  const masterHtml='self.__next_f.push([1,"items:[{\\\"name\\\":\\\"ニョロモ(マスターボールミラー)\\\",\\\"itemCode\\\":\\\"p1\\\",\\\"price\\\":830,\\\"sellPrice\\\":1800,\\\"modelNumber\\\":\\\"SV2a 060/165\\\",\\\"imageUrl\\\":\\\"u\\\",\\\"rarity\\\":\\\"C\\\"}]"])';
  const aliasHtml='self.__next_f.push([1,"items:[{\\\"name\\\":\\\"メガリザードンXex\\\",\\\"itemCode\\\":\\\"c1\\\",\\\"price\\\":2500,\\\"sellPrice\\\":5500,\\\"modelNumber\\\":\\\"M2a 223/193\\\",\\\"imageUrl\\\":\\\"u\\\",\\\"rarity\\\":\\\"MA\\\"}]"])';
  let mode='master';
  const ctx=vm.createContext({
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    encodeURIComponent,
    UrlFetchApp:{fetch:url=>({getResponseCode:()=>200,getContentText:()=>mode==='master'?masterHtml:(decodeURIComponent(url).includes('メガリザードンex')?'':aliasHtml)})}
  });
  vm.runInContext(code.slice(start,end),ctx);
  const master=vm.runInContext('fetchToretokuBuyback_',ctx)('ニョロモ','SV2a 060/165','060/165','マスターボールミラー');
  assert.equal(master?.price,830,'variant text in Toretoku product name is recognized');
  mode='alias';
  const normal=vm.runInContext('fetchToretokuBuyback_',ctx)('メガリザードンex','M2a 223/193','223/193','通常版');
  assert.equal(normal?.price,2500,'model retry accepts the confirmed M2a canonical X name');
}

{
  const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
  const start=code.indexOf('function fetchCardValueBuyback_('),end=code.indexOf('function fetchAltemaBuyback_(');
  const html='<html><body><h1>リザードン #137/103 [M6a] 30th CELEBRATION</h1><div>最高買取価格 ¥18,000</div></body></html>';
  const ctx=vm.createContext({
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>html})}
  });
  vm.runInContext(code.slice(start,end),ctx);
  const hit=vm.runInContext('fetchCardValueBuyback_',ctx)('リザードン','M6a 137/103','137/103','');
  assert.equal(hit?.price,18000,'exact product + set + number fallback accepts current max buyback');
  assert.equal(hit?.source,'ポケカ相場ナビ');
}


{
  const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
  const start=code.indexOf('function tv2EscapeRegex_('),end=code.indexOf('function fetchCardValueBuyback_(');
  const html='<html><body><h2>ブラッキーexの買取価格相場ランキング</h2><div>ブラッキーex SA/30th MF-044/040 ブラッキーex MF-044/040 × ブラッキーexのカード一覧 閉じる 9,500 円 -3,500円 12,800 円</div><h2>カード詳細</h2><div>型番 MF-044/040 買取価格 9,500 円 販売価格 12,800 円</div></body></html>';
  const ctx=vm.createContext({
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    encodeURIComponent,
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>html})}
  });
  vm.runInContext(code.slice(start,end),ctx);
  const hit=vm.runInContext('fetchGamepediaBuyback_',ctx)('ブラッキーex','MF 044/040','044/040','');
  assert.equal(hit?.price,9500,'Gamepedia exact-model parser reads the current buyback price');
  assert.equal(hit?.source,'攻略大百科');
}

{
  const code=fs.readFileSync(new URL('../automation/Code.gs',import.meta.url),'utf8');
  const start=code.indexOf('function tv2EscapeRegex_('),end=code.indexOf('function fetchCardValueBuyback_(');
  const html='<html><body>リザードン LV.76 137/103の買取価格・相場 M6a 137/103 基準買取価格 ￥22,000 前日 ￥18,000</body></html>';
  const ctx=vm.createContext({
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    encodeURIComponent,
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>html})}
  });
  vm.runInContext(code.slice(start,end),ctx);
  const hit=vm.runInContext('fetchToresiaBuyback_',ctx)('リザードン','M6a 137/103','137/103','');
  assert.equal(hit?.price,22000,'Toresia exact mapped page reads the live baseline buyback');
  assert.equal(hit?.source,'トレシア');
}

{
  const fallbackState={inventoryLots:[{id:'f2',category:'カード',product:'コイキング M6a 165/103',set:'M6a 165/103',condition:'良品',quantity:1}],marketQuotes:[]};
  const fallbackContext=vm.createContext({
    tv2Mutate_:(_kind,fn)=>fn(fallbackState),TZ:'Asia/Tokyo',
    Utilities:{formatDate:()=> '2026-09-28'},
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    extractModel_:x=>(String(x).match(/\d{3}\/\d{3}/)||[])[0]||'',
    fetchCardrushRows_:()=>{throw new Error('feed down')},
    findCardrushBuyback_:()=>null,
    fetchCardrushMediaBuyback_:()=>null,
    fetchToretokuBuyback_:()=>{throw new Error('source down')}
  });
  vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),fallbackContext);
  const hit=vm.runInContext('runTv2MarketAuto()',fallbackContext);
  assert.equal(hit.report.cardUpdated,0,'no source outside Cardrush/Toretoku may write a card quote');
  assert.equal(hit.report.cardReview,1);
  assert.equal(fallbackState.marketQuotes.length,0);
}


{
  const embeddedState={inventoryLots:[{id:'e1',category:'カード',product:'ピカチュウex M6a 127/103',set:'',condition:'良品',quantity:1}],marketQuotes:[{lotId:'e1',product:'ピカチュウex M6a 127/103',category:'カード',condition:'良品',price:10000,checkedAt:'2026-09-23',source:'公開買取相場'}]};
  const ctx=vm.createContext({
    tv2Mutate_:(_kind,fn)=>fn(embeddedState),TZ:'Asia/Tokyo',
    Utilities:{formatDate:()=> '2026-09-28'},
    normalize_:x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,''),
    extractModel_:x=>(String(x).match(/\d{3}\/\d{3}/)||[])[0]||'',
    fetchCardrushRows_:()=>[],
    findCardrushBuyback_:()=>null,
    fetchCardrushMediaBuyback_:()=>null,
    fetchToretokuBuyback_:(name,set,model)=>name==='ピカチュウex'&&set==='M6a 127/103'&&model==='127/103'?{price:7300,source:'トレトク買取'}:null,
    fetchToresiaBuyback_:()=>null,
    fetchGamepediaBuyback_:()=>null,
    fetchAltemaBuyback_:()=>null
  });
  vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),ctx);
  const hit=vm.runInContext('runTv2MarketAuto()',ctx);
  assert.equal(hit.report.cardUpdated,1,'embedded set code is separated from the card name for exact market lookup');
  assert.equal(embeddedState.marketQuotes[0].price,7300);
  assert.equal(embeddedState.marketQuotes[0].source,'トレトク買取');
}
