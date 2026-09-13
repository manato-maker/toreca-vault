const n=v=>Number(v)||0;
const stockCost=list=>list.reduce((s,x)=>s+n(x.cost)*n(x.quantity||1),0);
const marketValue=list=>list.reduce((s,x)=>s+n(x.marketPrice??x.buybackPrice)*n(x.quantity||1),0);
export function assets(state){
 const cards=marketValue(state.cards),boxes=marketValue(state.boxes),packs=marketValue(state.packs);
 const inventoryCost=stockCost(state.cards)+stockCost(state.boxes)+stockCost(state.packs);
 const total=cards+boxes+packs;const purchases=state.purchases.reduce((s,x)=>s+n(x.total??n(x.price)*n(x.quantity||1)),0);
 return{inventoryCost,cards,boxes,packs,total,purchases,difference:total-purchases};
}
export function storeStats(state){const map=new Map();for(const p of state.purchases){const name=p.store||'未設定';const row=map.get(name)||{store:name,purchases:0,spent:0,sales:0,revenue:0};row.purchases++;row.spent+=n(p.total??n(p.price)*n(p.quantity||1));map.set(name,row)}for(const s of state.sales){const name=s.store||'未設定';const row=map.get(name)||{store:name,purchases:0,spent:0,sales:0,revenue:0};row.sales++;row.revenue+=n(s.total??n(s.price)*n(s.quantity||1));map.set(name,row)}return[...map.values()].sort((a,b)=>b.spent-a.spent)}
