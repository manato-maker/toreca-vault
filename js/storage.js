import{emptyState,normalize,COLLECTIONS,SCHEMA_VERSION}from'./schema.js';
const KEY='toreca-vault:v1';
const PURCHASE_TARGET={BOX:'boxes','パック':'packs','カード':'cards'};
const qty=x=>Number(x?.quantity)||0;
function reconcilePurchaseInventory(state){
 for(const purchase of state.purchases||[]){
  const target=PURCHASE_TARGET[purchase.category];
  if(!target||purchase.inventoryAction==='記録のみ'||purchase.inventoryAction==='開封済')continue;
  const stockId=`stock-${purchase.id}`;
  if((state[target]||[]).some(x=>x.id===stockId||x.sourceId===purchase.id))continue;
  state[target].unshift({id:stockId,product:purchase.product,quantity:qty(purchase),cost:Number(purchase.price)||0,marketPrice:0,store:purchase.store,date:purchase.date,origin:'purchase',sourceId:purchase.id,memo:purchase.memo||''});
 }
 return state;
}
export function load(){try{const raw=localStorage.getItem(KEY);return reconcilePurchaseInventory(raw?normalize(JSON.parse(raw)):emptyState())}catch(e){console.warn('保存データを読み込めません',e);return emptyState()}}
export function save(state,{touch=true}={}){state=reconcilePurchaseInventory(state);state.schemaVersion=SCHEMA_VERSION;if(touch)state.updatedAt=new Date().toISOString();localStorage.setItem(KEY,JSON.stringify(state));return state}
export function merge(base,addition){const out=normalize(base);for(const key of COLLECTIONS){const seen=new Set(out[key].map(x=>x.id));for(const item of addition[key]||[])out[key].push(seen.has(item.id)?{...item,id:`${item.id}-imported-${Date.now()}`} : item)}return save(out)}
export function backup(state){return JSON.stringify({app:'toreca-vault',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:normalize(state)},null,2)}
export function restore(raw){const parsed=JSON.parse(raw);if(parsed.app!=='toreca-vault'||!parsed.data)throw new Error('Toreca Vaultのバックアップではありません');return save(normalize(parsed.data))}
