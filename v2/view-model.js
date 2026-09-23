const money=x=>Number(x)||0;
const qty=x=>Number(x?.quantity)||0;
const key=x=>String(x||'').trim().toLocaleLowerCase('ja');

function quoteMap(state){
 const byKey=new Map(),byLot=new Map();
 for(const q of state.marketQuotes||[]){
   if(q.lotId)byLot.set(String(q.lotId),q);
   else byKey.set([key(q.productKey||q.product),String(q.condition||'')].join('::'),q);
 }
 return {byKey,byLot};
}
const quoteFor=(quotes,lot)=>quotes.byLot.get(String(lot.id||''))||quotes.byKey.get([key(lot.productKey||lot.product),String(lot.condition||'')].join('::'));
export function v2ViewModel(state){
 const quotes=quoteMap(state);
 const purchases=[],sales=[],openings=[];
 for(const t of state.transactions||[]){
   if(t.type==='purchase')purchases.push(t);
   else if(t.type==='sale')sales.push(t);
   else if(t.type==='opening')openings.push(t);
 }
 const boxes=[],packs=[],cards=[];
 for(const l of state.inventoryLots||[]){
   const q=quoteFor(quotes,l);
   const base={id:l.id,product:l.product,productKey:l.productKey,category:l.category,condition:l.condition,shrinkStatus:l.condition,quantity:qty(l),cost:l.unitCost,marketPrice:q?.price??null,marketCheckedAt:q?.checkedAt||'',marketSource:q?.source||'',marketHistory:q?.history||[],date:l.acquiredAt||'',memo:l.memo||''};
   if(l.category==='BOX')boxes.push(base);else if(l.category==='パック')packs.push(base);else if(l.category==='カード')cards.push({...base,buybackPrice:q?.price??null});
 }
 const newestFirst=(a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.id||'').localeCompare(String(a.id||''));
 boxes.sort(newestFirst);packs.sort(newestFirst);cards.sort(newestFirst);
 return {purchases,sales,openings,lotteries:structuredClone(state.lotteries||[]),boxes,packs,cards,products:[]};
}
export function v2Assets(state){
 const q=quoteMap(state);let inventoryCost=0,boxes=0,packs=0,cards=0;
 for(const l of state.inventoryLots||[]){const n=qty(l),cost=l.unitCost==null?0:money(l.unitCost);inventoryCost+=cost*n;const quote=quoteFor(q,l);const value=(quote?.price==null?cost:money(quote.price))*n;if(l.category==='BOX')boxes+=value;else if(l.category==='パック')packs+=value;else if(l.category==='カード')cards+=value}
 const purchases=(state.transactions||[]).filter(t=>t.type==='purchase').reduce((n,t)=>n+(money(t.total)||money(t.price)*qty(t)),0);
 return {inventoryCost,boxes,packs,cards,total:boxes+packs+cards,purchases,difference:boxes+packs+cards-purchases};
}
export function v2RealizedProfit(state){
 return (state.transactions||[]).filter(t=>t.type==='sale'&&t.acquisitionCost!=null).reduce((n,t)=>n+money(t.price)*qty(t)-money(t.fee)-money(t.acquisitionCost),0);
}
