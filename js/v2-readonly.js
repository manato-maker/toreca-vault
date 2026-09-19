import{loadVaultV2,getVaultV2Config}from'../v2/browser-sync.js';
import{v2ViewModel,v2Assets,v2RealizedProfit}from'../v2/view-model.js';

export async function tryLoadV2ReadOnly(){
 const config=getVaultV2Config();if(!config.url||!config.token)return null;
 const remote=await loadVaultV2(config);
 return{canonical:remote.payload,state:v2ViewModel(remote.payload),assets:v2Assets(remote.payload),realizedProfit:v2RealizedProfit(remote.payload),revision:remote.revision,lastMutationId:remote.lastMutationId};
}
export function enableV2ReadOnly(url,token){
 const c={url:String(url||'').trim(),token:String(token||'').trim()};
 if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(c.url))throw new Error('Apps Scriptの /exec URLが必要です');
 if(c.token.length<24)throw new Error('同期キーが短すぎます');
 localStorage.setItem('toreca-vault:v2:sync',JSON.stringify(c));return c;
}
export function disableV2ReadOnly(){localStorage.removeItem('toreca-vault:v2:sync')}
export function hasV2ReadOnly(){const c=getVaultV2Config();return Boolean(c.url&&c.token)}
export function applyV2ReadOnlyToUi(currentState,snapshot){
 if(!snapshot?.state)return{state:currentState,active:false};
 return{state:snapshot.state,active:true,assets:snapshot.assets,realizedProfit:snapshot.realizedProfit,revision:snapshot.revision,lastMutationId:snapshot.lastMutationId};
}
