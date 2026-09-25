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
