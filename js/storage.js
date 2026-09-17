import{emptyState,normalize,COLLECTIONS,SCHEMA_VERSION}from'./schema.js';
const KEY='toreca-vault:v1';

// 在庫は購入・売却・開封の各処理でのみ増減させる。
// 購入履歴から在庫を毎回再生成すると、売却で0になり削除された在庫まで復活するため禁止。
const cleanInventory=state=>{for(const key of ['boxes','packs','cards'])state[key]=(state[key]||[]).filter(x=>(Number(x?.quantity)||0)>0);return state};
export function load(){try{const raw=localStorage.getItem(KEY);return cleanInventory(raw?normalize(JSON.parse(raw)):emptyState())}catch(e){console.warn('保存データを読み込めません',e);return emptyState()}}
export function save(state,{touch=true}={}){state=cleanInventory(normalize(state));state.schemaVersion=SCHEMA_VERSION;if(touch)state.updatedAt=new Date().toISOString();localStorage.setItem(KEY,JSON.stringify(state));return state}
export function merge(base,addition){const out=normalize(base);for(const key of COLLECTIONS){const seen=new Set(out[key].map(x=>x.id));for(const item of addition[key]||[])out[key].push(seen.has(item.id)?{...item,id:`${item.id}-imported-${Date.now()}`} : item)}return save(out)}
export function backup(state){return JSON.stringify({app:'toreca-vault',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:cleanInventory(normalize(state))},null,2)}
export function restore(raw){const parsed=JSON.parse(raw);if(parsed.app!=='toreca-vault'||!parsed.data)throw new Error('Toreca Vaultのバックアップではありません');return save(normalize(parsed.data))}
