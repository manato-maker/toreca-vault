import{getVaultV2Config}from'./browser-sync.js?v=20260930-jsonp-v1';
import{loadV2}from'./api-client.js?v=20260930-jsonp-v1';
import{repairCurrent20261004}from'./repair-current-20261004.js?v=20261004-v2';

async function runOneTimeRepairs(){
 const config=getVaultV2Config();
 if(!config.url||!config.token)return;
 const before=await loadV2(config.url,config.token);
 const snapshot={canonical:before.payload,revision:before.revision,lastMutationId:before.lastMutationId};
 const after=await repairCurrent20261004(snapshot);
 if(Number(after?.revision)!==Number(before.revision))location.reload();
}

runOneTimeRepairs().catch(err=>console.error('[Toreca Vault] verified self-repair failed',err));
