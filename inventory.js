const map={BOX:'boxes','パック':'packs','カード':'cards'};
const qty=x=>Number(x.quantity)||0;
const same=(a,b)=>String(a||'').trim().toLocaleLowerCase('ja')===String(b||'').trim().toLocaleLowerCase('ja');
const copy=s=>structuredClone(s);

function removeStock(items,product,quantity){
  let remaining=Number(quantity)||0,cost=0;
  const available=items.filter(x=>same(x.product,product)).reduce((n,x)=>n+qty(x),0);
  if(available<remaining)throw new Error(`${product}の在庫が不足しています（在庫 ${available}）`);
  for(const item of items){if(!same(item.product,product)||remaining<=0)continue;const take=Math.min(qty(item),remaining);item.quantity=qty(item)-take;cost+=take*(Number(item.cost)||0);remaining-=take}
  return{items:items.filter(x=>qty(x)>0),cost};
}

export function applyPurchase(state,purchase){
  const next=copy(state);next.purchases.unshift(purchase);const target=map[purchase.category];
  if(target&&purchase.inventoryAction!=='記録のみ')next[target].unshift({id:`stock-${purchase.id}`,product:purchase.product,quantity:qty(purchase),cost:Number(purchase.price)||0,marketPrice:0,store:purchase.store,date:purchase.date,origin:'purchase',sourceId:purchase.id});
  return next;
}

export function applySale(state,sale){
  const next=copy(state),target=map[sale.category];
  if(target&&sale.inventoryAction!=='記録のみ'){const result=removeStock(next[target],sale.product,sale.quantity);next[target]=result.items;sale.acquisitionCost=result.cost}
  next.sales.unshift(sale);return next;
}

export function applyOpening(state,opening){
  const next=copy(state),removed=removeStock(next.boxes,opening.product,opening.quantity);next.boxes=removed.items;opening.acquisitionCost=removed.cost;
  if(Number(opening.packQuantity)>0)next.packs.unshift({id:`pack-${opening.id}`,product:opening.packProduct||`${opening.product} 開封パック`,quantity:Number(opening.packQuantity),cost:0,marketPrice:0,date:opening.date,origin:'box-opening',sourceId:opening.id,memo:'BOX開封由来（取得原価0円）'});
  next.openings.unshift(opening);return next;
}
