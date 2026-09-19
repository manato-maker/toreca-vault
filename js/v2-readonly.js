import{loadVaultV2,getVaultV2Config}from'../v2/browser-sync.js';
import{v2ViewModel,v2Assets,v2RealizedProfit}from'../v2/view-model.js';

export async function tryLoadV2ReadOnly(){
 const config=getVaultV2Config();if(!config.url||!config.token)return null;
 const remote=await loadVaultV2(config);
 return{canonical:remote.payload,state:v2ViewModel(remote.payload),assets:v2Assets(remote.payload),realizedProfit:v2RealizedProfit(remote.payload),revision:remote.revision,lastMutationId:remote.lastMutationId};
}
