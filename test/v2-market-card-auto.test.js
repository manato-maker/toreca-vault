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
const rows=[['ピカチュウ(ミラー)','225/742','500'],['ピカチュウ','225/742','300'],['ピカチュウ(マスターボールミラー)','025/165','45000'],['ピカチュウ(モンスターボールミラー)','025/165','800'],['ピカチュウ','025/165','30']];
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','225/742','ミラー')?.price,500);
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165','モンスターボールミラー')?.price,800);
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165'),null,'number alone must not pick an arbitrary print');

{
  const fallbackState={inventoryLots:[{id:'f1',category:'カード',product:'ピカチュウ',set:'PROMO 001/SV-P',condition:'美品',quantity:1}],marketQuotes:[]};
  const fallbackContext=vm.createContext({
    tv2Mutate_:(_kind,fn)=>fn(fallbackState),TZ:'Asia/Tokyo',
    Utilities:{formatDate:()=> '2026-09-26'},
    normalize_:x=>String(x||'').toLowerCase(),
    extractModel_:x=>(String(x).match(/\d{3}\/(?:\d{3}|SV-P)/)||[])[0]||'',
    fetchCardrushRows_:()=>{throw new Error('feed down')},
    findCardrushBuyback_:()=>null,
    fetchCardrushRetail_:(name,model)=>name==='ピカチュウ'&&model==='001/SV-P'?{price:4480,source:'カードラッシュ販売価格'}:null,
    fetchAltemaBuyback_:()=>null
  });
  vm.runInContext(source.slice(0,source.indexOf('function tv2Mutate_(')),fallbackContext);
  const fallbackResult=vm.runInContext('runTv2MarketAuto()',fallbackContext);
  assert.equal(fallbackResult.report.cardUpdated,1,'cardrush fetch failure falls back for a standard card');
  assert.equal(fallbackState.marketQuotes[0].price,4480);
  assert.equal(fallbackState.marketQuotes[0].source,'カードラッシュ販売価格');
}
assert.equal(vm.runInContext('findCardrushBuyback_',prices)(rows,'ピカチュウ','025/165','マスターボールミラー')?.price,45000);
