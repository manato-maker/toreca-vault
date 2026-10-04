import {saveV2} from './api-client.js?v=20260930-jsonp-v1';
import {getVaultV2Config,validateBrowserState} from './browser-sync.js?v=20260930-jsonp-v1';
import {v2ViewModel,v2Assets,v2RealizedProfit} from './view-model.js';

const norm=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,'').replace(/[‐‑–—―ーｰ−]/g,'-');
const REQUESTS={
  stormYes:'20261003-sale-storm-emeralda-shrink-yes-9200',
  stormNo:'20261003-sale-storm-emeralda-shrink-no-7500',
  dragon:'20261003-sale-dragonball-brightness-of-hope-tape-8300',
  sylveon:'20261004-sale-sylveon-v-s8b-231-184-5000'
};
const APP_NO='1054301100';
const REPAIR_TYPE='browser-repair-current-20261004-v1';

function conditionKey(value){
  const v=norm(value);
  if(/シュリンク/.test(v))return /なし|無/.test(v)?'shrink-no':/あり|有/.test(v)?'shrink-yes':v;
  if(/テープ/.test(v))return /なし|無/.test(v)?'tape-no':/あり|有|付/.test(v)?'tape-yes':v;
  if(/^(あり|有)$/.test(v))return'yes';
  if(/^(なし|無)$/.test(v))return'no';
  return v;
}
function conditionMatches(requested,actual){
  const r=conditionKey(requested),a=conditionKey(actual);
  if(!r)return true;
  if(r===a)return true;
  if((r==='shrink-yes'||r==='tape-yes')&&a==='yes')return true;
  if((r==='shrink-no'||r==='tape-no')&&a==='no')return true;
  return false;
}
function storeMatches(tx,store){return norm(tx.store||tx.soldTo).includes(norm(store))}
function semanticSale(state,product,date,store,price){
  return state.transactions.find(tx=>tx.type==='sale'&&norm(tx.productKey||tx.product).includes(norm(product))&&String(tx.date||'')===date&&storeMatches(tx,store)&&Number(tx.price||tx.unitPrice||0)===price&&Number(tx.quantity||0)===1);
}
function consumeOne(lots){
  const candidates=lots.filter(x=>Number(x.quantity)>0).sort((a,b)=>String(a.acquiredAt||'').localeCompare(String(b.acquiredAt||''))||String(a.id||'').localeCompare(String(b.id||'')));
  const lot=candidates[0];
  if(!lot)return{cost:null,used:null};
  const raw=lot.unitCost;
  lot.quantity=Number(lot.quantity)-1;
  return{cost:raw===null||raw===undefined||raw===''||!Number.isFinite(Number(raw))?null:Number(raw),used:String(lot.id||'')};
}
function ensureSale(state,spec,changes){
  const id='chat-sale-'+spec.requestId;
  const existing=state.transactions.find(tx=>String(tx.id||'')===id)||semanticSale(state,spec.matchProduct,spec.date,spec.store,spec.price);
  if(existing)return existing;
  const lots=state.inventoryLots.filter(l=>Number(l.quantity)>0&&l.category===spec.category&&spec.matchLot(l));
  const consumed=consumeOne(lots);
  const tx={id,type:'sale',product:spec.product,productKey:spec.product,category:spec.category,condition:spec.condition||'',set:spec.set||'',quantity:1,price:spec.price,date:spec.date,store:spec.store,soldTo:spec.store,source:'browser-repair',requestId:spec.requestId,acquisitionCost:consumed.cost,memo:'ユーザー確認済み売却｜2026/10/04 自動整合補正'};
  state.transactions.push(tx);changes.push('sale:'+spec.requestId);return tx;
}
function repairCanonical(state){
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  state.marketQuotes=Array.isArray(state.marketQuotes)?state.marketQuotes:[];
  state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  state.auditLog=Array.isArray(state.auditLog)?state.auditLog:[];
  const changes=[];
  const stormBase=l=>Number(l.quantity)>0&&l.category==='BOX'&&norm(l.productKey||l.product)===norm('ストームエメラルダ');
  ensureSale(state,{requestId:REQUESTS.stormYes,product:'ストームエメラルダ',matchProduct:'ストームエメラルダ',category:'BOX',condition:'シュリンクあり',date:'2026-10-03',store:'買取ミミ',price:9200,matchLot:l=>stormBase(l)&&conditionMatches('シュリンクあり',l.condition)},changes);
  ensureSale(state,{requestId:REQUESTS.stormNo,product:'ストームエメラルダ',matchProduct:'ストームエメラルダ',category:'BOX',condition:'シュリンクなし',date:'2026-10-03',store:'買取ミミ',price:7500,matchLot:l=>stormBase(l)&&conditionMatches('シュリンクなし',l.condition)},changes);
  const stormIds=new Set(state.inventoryLots.filter(stormBase).map(l=>String(l.id||'')));
  if(stormIds.size){
    const removed=state.inventoryLots.filter(l=>stormIds.has(String(l.id||''))).reduce((n,l)=>n+Number(l.quantity||0),0);
    state.inventoryLots=state.inventoryLots.filter(l=>!stormIds.has(String(l.id||'')));
    state.marketQuotes=state.marketQuotes.filter(q=>!stormIds.has(String(q.lotId||'')));
    changes.push('storm-inventory-zero:'+removed);
  }
  ensureSale(state,{requestId:REQUESTS.dragon,product:'ドラゴンボール BRIGHTNESS OF HOPE',matchProduct:'BRIGHTNESS OF HOPE',category:'BOX',condition:'テープ付き',date:'2026-10-03',store:'買取ミミ',price:8300,matchLot:l=>Number(l.quantity)>0&&l.category==='BOX'&&norm(l.productKey||l.product).includes(norm('BRIGHTNESS OF HOPE'))&&conditionMatches('テープ付き',l.condition)},changes);
  ensureSale(state,{requestId:REQUESTS.sylveon,product:'ニンフィアV',matchProduct:'ニンフィアV',category:'カード',condition:'',set:'S8b 231/184',date:'2026-10-04',store:'三洋堂トレカ館 桜井店',price:5000,matchLot:l=>{
    if(Number(l.quantity)<=0||l.category!=='カード')return false;
    const text=norm(String(l.product||l.productKey||'')+' '+String(l.set||''));
    return text.includes(norm('ニンフィアV'))&&text.includes(norm('231/184'));
  }},changes);
  const lotteryId='lottery-livepocket-'+APP_NO;
  let lottery=state.lotteries.find(x=>String(x.id||'')===lotteryId||String(x.memo||'').includes(APP_NO));
  if(!lottery){lottery={id:lotteryId,createdAt:new Date().toISOString(),receiptStatus:'対象外',receivedDate:''};state.lotteries.push(lottery);changes.push('livepocket:'+APP_NO)}
  const before=JSON.stringify(lottery);
  lottery.title='30th CELEBRATION';
  lottery.store='イエローサブマリン なんば本店';
  if(!['当選','落選','購入済'].includes(String(lottery.status||'')))lottery.status='応募済';
  lottery.resultDate='2026-10-10';
  lottery.gmailMessageId='1a1045fa729f0163';
  lottery.updatedAt=new Date().toISOString();
  if(!String(lottery.memo||'').includes(APP_NO))lottery.memo=[lottery.memo,'自動登録｜申込番号 '+APP_NO].filter(Boolean).join('｜');
  if(JSON.stringify(lottery)!==before&&!changes.includes('livepocket:'+APP_NO))changes.push('livepocket-update:'+APP_NO);
  state.inventoryLots=state.inventoryLots.filter(l=>Number(l.quantity)>0);
  return changes;
}
function verify(state){
  const saleCount=requestId=>state.transactions.filter(t=>String(t.requestId||'')===requestId||String(t.id||'')==='chat-sale-'+requestId).length;
  const stormQty=state.inventoryLots.filter(l=>Number(l.quantity)>0&&l.category==='BOX'&&norm(l.productKey||l.product)===norm('ストームエメラルダ')).reduce((n,l)=>n+Number(l.quantity||0),0);
  const lp=state.lotteries.filter(x=>String(x.id||'').includes(APP_NO)||String(x.memo||'').includes(APP_NO));
  return stormQty===0&&Object.values(REQUESTS).every(id=>saleCount(id)===1)&&lp.length===1&&String(lp[0].resultDate||'').slice(0,10)==='2026-10-10'&&norm(lp[0].store).includes(norm('なんば本店'));
}
function snapshotFromRemote(remote){
  return{canonical:remote.payload,state:v2ViewModel(remote.payload),assets:v2Assets(remote.payload),realizedProfit:v2RealizedProfit(remote.payload),automationHealth:structuredClone(remote.payload.automation?.health||{}),revision:remote.revision,lastMutationId:remote.lastMutationId};
}
export async function repairCurrent20261004(snapshot){
  if(!snapshot?.canonical||!Number.isFinite(Number(snapshot.revision)))return snapshot;
  if(verify(snapshot.canonical))return snapshot;
  const next=structuredClone(snapshot.canonical),changes=repairCanonical(next);
  if(!changes.length){if(!verify(next))throw new Error('既知の未反映データを自動整合できませんでした');return snapshot}
  const mutationId=REPAIR_TYPE+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);
  next.revision=Number(snapshot.revision)+1;
  next.lastMutationId=mutationId;
  next.auditLog.push({mutationId,revision:next.revision,type:REPAIR_TYPE,at:new Date().toISOString(),changes});
  validateBrowserState(next);
  const config=getVaultV2Config();
  const confirmed=await saveV2(config.url,config.token,next,snapshot.revision);
  if(!verify(confirmed.payload))throw new Error('既知の未反映データを保存後に再確認できませんでした');
  return snapshotFromRemote(confirmed);
}
