import {loadV2,saveV2} from './api-client.js';

const clone=x=>structuredClone(x);
const requiredArrays=['transactions','inventoryLots','lotteries','marketQuotes','auditLog'];

export function validateBrowserState(state){
  if(!state||Number(state.schemaVersion)!==2)throw new Error('V2データではありません');
  for(const k of requiredArrays)if(!Array.isArray(state[k]))throw new Error(k+' が不正です');
  return true;
}

export function getVaultV2Config(){
  try{return JSON.parse(localStorage.getItem('toreca-vault:v2:sync')||'{}')}catch{return{}}
}
export function setVaultV2Config(url,token){
  const c={url:String(url||'').trim(),token:String(token||'').trim()};
  if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(c.url))throw new Error('Apps Scriptの /exec URLが必要です');
  if(c.token.length<24)throw new Error('同期キーが短すぎます');
  localStorage.setItem('toreca-vault:v2:sync',JSON.stringify(c));return c;
}
export function clearVaultV2Config(){localStorage.removeItem('toreca-vault:v2:sync')}

export async function loadVaultV2(config=getVaultV2Config()){
  if(!config.url||!config.token)throw new Error('V2同期設定がありません');
  const r=await loadV2(config.url,config.token);validateBrowserState(r.payload);
  return r;
}

export async function acceptanceWrite(config=getVaultV2Config()){
  const before=await loadVaultV2(config),next=clone(before.payload);
  const mutationId='browser-acceptance-'+Date.now();
  next.revision=Number(before.revision)+1;
  next.lastMutationId=mutationId;
  next.auditLog.push({mutationId,type:'acceptance-test',at:new Date().toISOString()});
  validateBrowserState(next);
  const confirmed=await saveV2(config.url,config.token,next,before.revision);
  const reread=await loadVaultV2(config);
  if(Number(reread.revision)!==Number(next.revision)||reread.lastMutationId!==mutationId)throw new Error('V2書込後の再読込検証に失敗しました');
  if(reread.payload.auditLog.filter(x=>x.mutationId===mutationId).length!==1)throw new Error('V2受入ログが重複しています');
  return {before,confirmed,reread,mutationId};
}
