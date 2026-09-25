import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
const html='<div class="card" data-cat="box" data-name="MEGAドリームEX"><span class="official">ハイクラスパック 「MEGAドリームex」</span><div class="crow" data-cond="shrink"><div class="cell"><a class="shop-link" href="https://x.com/AMTAF_SHOP">AMTAF</a><span class="price yen">¥12,000</span><a class="src" href="https://x.com/AMTAF_SHOP/status/123">出典</a></div><div class="cell"><a class="shop-link" href="https://x.com/mimi_kaitori">買取ミミ</a><span class="price yen">¥11,500</span><a class="src" href="https://x.com/mimi_kaitori/status/124">出典</a></div></div></div><footer>掲載日 <b>2026-09-25</b> / スナップショット 2026-09-25 15:00</footer>';
const state={inventoryLots:[{id:'b1',category:'BOX',product:'MEGAドリームex',condition:'あり',quantity:1}],marketQuotes:[]};
const timeline={data:[
 {id:'300',created_at:'2026-09-25T09:00:00Z',text:'こちらの金額に変更させて頂きます',attachments:{media_keys:['photo2']}},
 {id:'200',created_at:'2026-09-25T06:00:00Z',text:'BOX買取 MEGAドリームex シュリンクあり 13,000円'}
],includes:{media:[{media_key:'photo2',type:'photo',url:'https://pbs.twimg.com/media/example.jpg'}]}};
let visionText='MEGAドリームex シュリンクあり ¥11,000円';
const context=vm.createContext({
 tv2Mutate_:(_kind,fn)=>fn(state),TZ:'Asia/Tokyo',
 Utilities:{formatDate:()=> '2026-09-25',base64Encode:()=> 'image-base64'},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>({'TV2_X_BEARER_TOKEN':'test-token','TV2_VISION_API_KEY':'test-vision'}[k]||'')})},
 UrlFetchApp:{fetch:url=>{
  if(url==='https://torekakaku-navi.com/')return{getResponseCode:()=>200,getContentText:()=>html};
  if(url.includes('/users/by/username/')){const handle=decodeURIComponent(url.split('/').at(-1));return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({data:{id:handle==='AMTAF_SHOP'?'1':handle==='mimi_kaitori'?'2':'3',username:handle}})}}
  if(url.includes('/users/1/tweets'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(timeline)};
  if(url.includes('/users/2/tweets')||url.includes('/users/3/tweets'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({data:[]})};
  if(url.includes('pbs.twimg.com'))return{getResponseCode:()=>200,getBlob:()=>({getBytes:()=>[1,2,3]})};
  if(url.includes('vision.googleapis.com'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({responses:[{fullTextAnnotation:{text:visionText}}]})};
  throw new Error('Unexpected URL '+url)
 }},
 normalize_:s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'')
});
vm.runInContext(src.slice(0,src.indexOf('function tv2Mutate_(')),context);
assert.equal(vm.runInContext("tv2PickupLineOffer_('ポケモンカード151 シュリンクあり 35,000円',{product:'ポケモンカード151',category:'BOX',condition:'あり'}).price",context),35000);
assert.equal(vm.runInContext("tv2PickupLineOffer_('MEGAドリームex 11,000円',{product:'MEGAドリームex',category:'BOX',condition:'あり'})",context),null,'missing condition is rejected');
const result=vm.runInContext('runTv2MarketAuto()',context);
assert.equal(result.report.updated,1);
assert.equal(state.marketQuotes[0].price,11500,'later pickup drop replaces earlier shop price before comparing shops');
assert.equal(state.marketQuotes[0].shopOffers.AMTAF.price,11000);
assert.equal(state.marketQuotes[0].shopOffers.AMTAF.postId,'300');
assert.equal(state.marketQuotes[0].shopOffers['買取ミミ'].price,11500);
assert.equal(state.automation.health.xLastSeen.AMTAF_SHOP,'300');
vm.runInContext('runTv2MarketAuto()',context);
assert.equal(state.marketQuotes[0].price,11500,'repeat is idempotent');
visionText='価格改定しました（判読不能）';
timeline.data.unshift({id:'400',created_at:'2026-09-25T10:00:00Z',text:'こちらの金額に変更させて頂きます',attachments:{media_keys:['photo2']}});
vm.runInContext('runTv2MarketAuto()',context);
assert.equal(state.marketQuotes[0].price,11500,'unreadable image never changes a quote');
assert.equal(state.automation.health.xUncertainShops[0],'AMTAF');
assert.equal(state.automation.health.marketStatus,'review');
