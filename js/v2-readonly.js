import{loadVaultV2,getVaultV2Config,setVaultV2Config,clearVaultV2Config}from'../v2/browser-sync.js';
import{v2ViewModel,v2Assets,v2RealizedProfit}from'../v2/view-model.js';

export async function tryLoadV2ReadOnly(){
 const config=getVaultV2Config();if(!config.url)throw new Error('V2接続URLがありません');if(!config.token)throw new Error('このタブではV2同期キーが未設定です。V2へ接続から再接続してください');
 const remote=await loadVaultV2(config);
 return{canonical:remote.payload,state:v2ViewModel(remote.payload),assets:v2Assets(remote.payload),realizedProfit:v2RealizedProfit(remote.payload),automationHealth:structuredClone(remote.payload.automation?.health||{}),revision:remote.revision,lastMutationId:remote.lastMutationId};
}
export function enableV2ReadOnly(url,token){return setVaultV2Config(url,token)}
export function disableV2ReadOnly(){clearVaultV2Config()}
export function hasV2ReadOnly(){const c=getVaultV2Config();return Boolean(c.url)}
export function applyV2ReadOnlyToUi(currentState,snapshot){
 if(!snapshot?.state)return{state:currentState,active:false};
 return{state:snapshot.state,active:true,assets:snapshot.assets,realizedProfit:snapshot.realizedProfit,automationHealth:snapshot.automationHealth||{},revision:snapshot.revision,lastMutationId:snapshot.lastMutationId};
}
