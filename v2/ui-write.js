import{applyTransaction,validateState}from'./core.js';
import{loadVaultV2,getVaultV2Config}from'./browser-sync.js';
import{saveV2}from'./api-client.js';
import{assertV2WriteEnabled}from'./write-gate.js';

const makeId=(prefix='tx')=>prefix+'-'+Date.now()+'-'+crypto.randomUUID();
export function normalizeUiTransaction(type,data){
 if(!['purchase','sale','opening'].includes(type))throw new Error('V2取引種別が不正です');
 const category=String(data.category||'').trim();
 const condition=String(data.condition||data.shrinkStatus||'').trim();
 return{...data,id:data.id||makeId(type),type,product:String(data.product||'').trim(),productKey:String(data.productKey||data.product||'').trim(),category,condition,quantity:Number(data.quantity)};
}
export async function commitV2Transaction(type,data,config=getVaultV2Config()){
 assertV2WriteEnabled();
 const before=await loadVaultV2(config),tx=normalizeUiTransaction(type,data);
 const mutationId='ui-'+tx.id;
 const next=applyTransaction(before.payload,tx,mutationId);validateState(next);
 const confirmed=await saveV2(config.url,config.token,next,before.revision);
 const reread=await loadVaultV2(config);
 const stored=reread.payload.transactions.filter(x=>x.id===tx.id);
 const audits=reread.payload.auditLog.filter(x=>x.mutationId===mutationId);
 if(stored.length!==1||audits.length!==1)throw new Error('V2保存後の一意性検証に失敗しました');
 if(reread.lastMutationId!==mutationId||Number(reread.revision)!==Number(next.revision))throw new Error('V2保存後のrevision検証に失敗しました');
 return{transaction:stored[0],payload:reread.payload,revision:reread.revision,lastMutationId:reread.lastMutationId,confirmed};
}
