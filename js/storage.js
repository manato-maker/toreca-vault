import{emptyState,normalize,COLLECTIONS,SCHEMA_VERSION}from'./schema.js';
const KEY='toreca-vault:v1';
export function load(){try{const raw=localStorage.getItem(KEY);return raw?normalize(JSON.parse(raw)):emptyState()}catch(e){console.warn('保存データを読み込めません',e);return emptyState()}}
export function save(state,{touch=true}={}){state.schemaVersion=SCHEMA_VERSION;if(touch)state.updatedAt=new Date().toISOString();localStorage.setItem(KEY,JSON.stringify(state));return state}
export function merge(base,addition){const out=normalize(base);for(const key of COLLECTIONS){const seen=new Set(out[key].map(x=>x.id));for(const item of addition[key]||[])out[key].push(seen.has(item.id)?{...item,id:`${item.id}-imported-${Date.now()}`} : item)}return save(out)}
export function backup(state){return JSON.stringify({app:'toreca-vault',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:normalize(state)},null,2)}
export function restore(raw){const parsed=JSON.parse(raw);if(parsed.app!=='toreca-vault'||!parsed.data)throw new Error('Toreca Vaultのバックアップではありません');return save(normalize(parsed.data))}
