const n=v=>Number(v)||0;
const quantity=x=>x.quantity==null?1:n(x.quantity);
const stockCost=list=>list.reduce((s,x)=>s+n(x.cost)*quantity(x),0);
const marketValue=list=>list.reduce((s,x)=>s+n(x.marketPrice??x.buybackPrice)*quantity(x),0);
const saleRevenue=x=>n(x.price)*quantity(x)-n(x.fee);
export function assets(state){
 const cards=marketValue(state.cards),boxes=marketValue(state.boxes),packs=marketValue(state.packs);
 const inventoryCost=stockCost(state.cards)+stockCost(state.boxes)+stockCost(state.packs);
 const total=cards+boxes+packs;
 const purchases=state.purchases.reduce((s,x)=>s+n(x.total??n(x.price)*quantity(x)),0);
 const sales=state.sales.reduce((s,x)=>s+saleRevenue(x),0);
 const realizedProfit=state.sales.reduce((s,x)=>s+saleRevenue(x)-n(x.acquisitionCost),0);
 const unrealizedProfit=total-inventoryCost;
 const totalProfit=unrealizedProfit+realizedProfit;
 const netInvested=purchases-sales;
 return{inventoryCost,cards,boxes,packs,total,purchases,sales,realizedProfit,unrealizedProfit,totalProfit,netInvested,difference:unrealizedProfit};
}
export function storeStats(state){const map=new Map();for(const p of state.purchases){const name=p.store||'未設定';const row=map.get(name)||{store:name,purchases:0,spent:0,sales:0,revenue:0};row.purchases++;row.spent+=n(p.total??n(p.price)*quantity(p));map.set(name,row)}for(const s of state.sales){const name=s.store||'未設定';const row=map.get(name)||{store:name,purchases:0,spent:0,sales:0,revenue:0};row.sales++;row.revenue+=n(s.total??n(s.price)*quantity(s));map.set(name,row)}return[...map.values()].sort((a,b)=>b.spent-a.spent)}
