const CATEGORIES=new Set(['BOX','パック','カード']);
const CONDITIONS=new Set(['あり','なし','対象外','未開封','']);
const clone=x=>structuredClone(x);
const qty=x=>Number(x?.quantity)||0;
const money=x=>Number(x)||0;
const knownMoney=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
const key=x=>String(x||'').trim().toLocaleLowerCase('ja');
const sortLots=lots=>lots.sort((a,b)=>String(a.acquiredAt||'').localeCompare(String(b.acquiredAt||''))||String(a.id||'').localeCompare(String(b.id||'')));

export function emptyV2(){
  return {schemaVersion:2,revision:0,lastMutationId:'',transactions:[],inventoryLots:[],lotteries:[],marketQuotes:[],auditLog:[],automation:{health:{}}};
}
export function inventoryKey(x){return [key(x.productKey||x.product),String(x.condition||x.shrinkStatus||'')].join('::')}
export function validateState(state){
  if(!state||state.schemaVersion!==2)throw new Error('schemaVersion=2 が必要です');
  for(const name of ['transactions','inventoryLots','lotteries','marketQuotes','auditLog'])if(!Array.isArray(state[name]))throw new Error(name+' が配列ではありません');
  const tx=new Set(),lots=new Set();
  for(const t of state.transactions){if(!t.id||tx.has(t.id))throw new Error('transactionId が重複または未設定です');tx.add(t.id)}
  for(const l of state.inventoryLots){if(!l.id||lots.has(l.id))throw new Error('inventory lot id が重複または未設定です');lots.add(l.id);if(qty(l)<=0)throw new Error('在庫数量は正数のみです');if(!CATEGORIES.has(l.category))throw new Error('在庫カテゴリが不正です');if(l.category==='BOX'&&!CONDITIONS.has(String(l.condition||'')))throw new Error('BOX condition が不正です')}
  return true;
}
function consumeFIFO(lots,sale){
  let remaining=qty(sale),cost=0,unknownCost=false;
  const wanted=inventoryKey(sale);
  const ordered=sortLots(lots.filter(l=>inventoryKey(l)===wanted));
  const available=ordered.reduce((n,l)=>n+qty(l),0);
  if(available<remaining)throw new Error('在庫不足');
  for(const lot of ordered){if(!remaining)break;const take=Math.min(qty(lot),remaining);lot.quantity=qty(lot)-take;if(knownMoney(lot.unitCost)===null)unknownCost=true;else cost+=take*Number(lot.unitCost);remaining-=take}
  return unknownCost?null:cost;
}
export function applyTransaction(state,input,mutationId){
  validateState(state);
  if(!mutationId)throw new Error('mutationId が必要です');
  if(state.lastMutationId===mutationId||state.auditLog.some(x=>x.mutationId===mutationId))return clone(state);
  if(!input?.id||state.transactions.some(x=>x.id===input.id))throw new Error('transactionId が重複または未設定です');
  if(!['purchase','sale','opening'].includes(input.type))throw new Error('transaction type が不正です');
  if(!String(input.productKey||input.product||'').trim())throw new Error('product が必要です');
  if(!Number.isInteger(Number(input.quantity))||Number(input.quantity)<=0)throw new Error('quantity は正の整数が必要です');
  if(!CATEGORIES.has(input.category))throw new Error('category が不正です');
  const next=clone(state),t=clone(input);
  if(t.type==='purchase'){
    next.inventoryLots.push({id:'lot-'+t.id,product:t.product,productKey:t.productKey||t.product,category:t.category,condition:t.condition||t.shrinkStatus||'',quantity:qty(t),unitCost:knownMoney(t.unitCost??t.price),acquiredAt:t.date||'',sourceTransactionId:t.id});
  }else if(t.type==='sale'){
    t.acquisitionCost=consumeFIFO(next.inventoryLots,t);
    next.inventoryLots=next.inventoryLots.filter(l=>qty(l)>0);
  }else{
    t.acquisitionCost=consumeFIFO(next.inventoryLots,t);
    next.inventoryLots=next.inventoryLots.filter(l=>qty(l)>0);
  }
  next.transactions.push(t);next.revision=money(next.revision)+1;next.lastMutationId=mutationId;
  next.auditLog.push({mutationId,transactionId:t.id,revision:next.revision});
  validateState(next);return next;
}
export function realizedProfit(state){
  return state.transactions.filter(t=>t.type==='sale'&&t.acquisitionCost!==null&&t.acquisitionCost!==undefined&&t.acquisitionCost!=='').reduce((n,t)=>n+(money(t.price)*qty(t)-money(t.fee)-money(t.acquisitionCost)),0);
}
export function positiveMarketTargets(state){
  const seen=new Set(),out=[];for(const l of state.inventoryLots){if(qty(l)<=0)continue;const k=inventoryKey(l);if(seen.has(k))continue;seen.add(k);out.push({product:l.product,productKey:l.productKey,category:l.category,condition:l.condition})}return out;
}
