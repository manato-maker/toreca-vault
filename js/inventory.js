const map={BOX:'boxes','パック':'packs','カード':'cards'};
const qty=x=>Number(x.quantity)||0;
const same=(a,b)=>String(a||'').trim().toLocaleLowerCase('ja')===String(b||'').trim().toLocaleLowerCase('ja');
const copy=s=>structuredClone(s);
const keyOf=x=>String(x.inventoryKey||x.product||'').trim().toLocaleLowerCase('ja');
const conditionOf=x=>String(x.shrinkStatus||'').trim();

function assertCategory(record,kind){
  if(record.inventoryAction==='記録のみ')return;
  if(!map[record.category])throw new Error(`${kind}の在庫種別が不正です（${record.category||'未設定'}）。BOX・パック・カードから選んでください`);
}

function removeStock(items,record){
  let remaining=qty(record),cost=0;
  const wantedKey=keyOf(record),wantedCondition=conditionOf(record);
  const matches=x=>keyOf(x)===wantedKey&&(!wantedCondition||conditionOf(x)===wantedCondition);
  const available=items.filter(matches).reduce((n,x)=>n+qty(x),0);
  if(available<remaining)throw new Error(`${record.product}の在庫が不足しています（条件一致在庫 ${available}）`);
  // 配列順を取得順としてFIFOで原価を充当。inventoryKey と shrinkStatus で別商品・状態の誤減算を防ぐ。
  for(const item of items){if(!matches(item)||remaining<=0)continue;const take=Math.min(qty(item),remaining);item.quantity=qty(item)-take;cost+=take*(Number(item.cost)||0);remaining-=take}
  return{items:items.filter(x=>qty(x)>0),cost};
}

export function applyPurchase(state,purchase){
  const next=copy(state);assertCategory(purchase,'購入');next.purchases.unshift(purchase);const target=map[purchase.category];
  // 購入先は購入履歴だけに保持し、在庫レコードには持ち込まない。
  if(target&&purchase.inventoryAction!=='記録のみ')next[target].unshift({id:`stock-${purchase.id}`,product:purchase.product,inventoryKey:purchase.inventoryKey||'',shrinkStatus:purchase.shrinkStatus||'',quantity:qty(purchase),cost:Number(purchase.price)||0,marketPrice:0,date:purchase.date,origin:'purchase',sourceId:purchase.id,memo:purchase.memo||''});
  return next;
}

export function applySale(state,sale){
  const next=copy(state);assertCategory(sale,'売却');const target=map[sale.category];
  if(target&&sale.inventoryAction!=='記録のみ'){const result=removeStock(next[target],sale);next[target]=result.items;sale.acquisitionCost=result.cost}
  else if(sale.acquisitionCost==null)sale.acquisitionCost=null;
  next.sales.unshift(sale);return next;
}

export function applyOpening(state,opening){
  const next=copy(state),removed=removeStock(next.boxes,{...opening,category:'BOX'});next.boxes=removed.items;opening.acquisitionCost=removed.cost;
  if(Number(opening.packQuantity)>0)next.packs.unshift({id:`pack-${opening.id}`,product:opening.packProduct||`${opening.product} 開封パック`,quantity:Number(opening.packQuantity),cost:0,marketPrice:0,date:opening.date,origin:'box-opening',sourceId:opening.id,memo:'BOX開封由来（取得原価0円）'});
  next.openings.unshift(opening);return next;
}
