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
 let before;try{before=await loadVaultV2(config)}catch(err){throw new Error('batch preflight: '+String(err?.message||err))}assertV2WriteEnabled(before.revision);const tx=normalizeUiTransaction(type,data);
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

export async function commitV2Batch(items,config=getVaultV2Config()){
 const before=await loadVaultV2(config);assertV2WriteEnabled(before.revision);
 if(!Array.isArray(items)||!items.length)throw new Error('一括反映データがありません');
 let next=before.payload;const txs=[];const batchId='ui-batch-'+crypto.randomUUID();
 for(let i=0;i<items.length;i++){
  const item=items[i],tx=normalizeUiTransaction(item.type,item.data),mutationId=batchId+'-'+String(i+1);
  next=applyTransaction(next,tx,mutationId);txs.push({tx,mutationId});
 }
 // A batch is one persisted mutation. applyTransaction increments revision per item,
 // but the server contract requires exactly +1 per save.
 next.revision=Number(before.revision)+1;
 next.lastMutationId=txs.at(-1).mutationId;
 // Keep per-item audit entries, but bind them to the single persisted revision.
 for(const {mutationId} of txs){const audit=next.auditLog.find(x=>x.mutationId===mutationId);if(audit)audit.revision=next.revision}
 validateState(next);const confirmed=await saveV2(config.url,config.token,next,before.revision);const reread=await loadVaultV2(config);
 for(const {tx,mutationId} of txs){if(reread.payload.transactions.filter(x=>x.id===tx.id).length!==1)throw new Error('一括反映後の取引一意性検証に失敗しました');if(reread.payload.auditLog.filter(x=>x.mutationId===mutationId).length!==1)throw new Error('一括反映後の監査検証に失敗しました')}
 if(Number(reread.revision)!==Number(next.revision)||reread.lastMutationId!==txs.at(-1).mutationId)throw new Error('一括反映後のrevision検証に失敗しました');
 return{transactions:txs.map(x=>x.tx),payload:reread.payload,revision:reread.revision,lastMutationId:reread.lastMutationId,confirmed};
}
