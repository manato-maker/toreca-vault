import{loadV2,saveV2}from'./api-client.js';
import{acceptanceSnapshot}from'./acceptance.js';
const clone=x=>structuredClone(x);
async function postRaw(url,body){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body)});
 return r.json();
}
function assertBusinessUnchanged(base,after){
 for(const k of ['transactions','inventoryLots','lotteries','marketQuotes'])
  if(JSON.stringify(base[k]||[])!==JSON.stringify(after[k]||[]))throw new Error('受入試験で業務データが変化しました: '+k);
}
export async function runSafeApiAcceptance(url,token){
 const before=await loadV2(url,token),base=clone(before.payload);
 const mutationId='acceptance-'+Date.now()+'-'+crypto.randomUUID();
 const next=clone(base);next.revision=Number(before.revision)+1;next.lastMutationId=mutationId;next.auditLog=[...(next.auditLog||[]),{mutationId,type:'acceptance',at:new Date().toISOString(),memo:'V2 API acceptance test — no business data changed'}];
 const confirmed=await saveV2(url,token,next,before.revision);
 const afterWrite=await loadV2(url,token);
 assertBusinessUnchanged(base,afterWrite.payload);
 const duplicate=await postRaw(url,{token,expectedRevision:before.revision,mutationId,payload:next});
 if(!duplicate.ok||duplicate.duplicate!==true||Number(duplicate.revision)!==Number(afterWrite.revision))throw new Error('二重送信防止テスト失敗');
 const staleMutationId='stale-'+Date.now()+'-'+crypto.randomUUID(),stalePayload=clone(afterWrite.payload);
 stalePayload.revision=Number(afterWrite.revision)+1;stalePayload.lastMutationId=staleMutationId;
 const stale=await postRaw(url,{token,expectedRevision:before.revision,mutationId:staleMutationId,payload:stalePayload});
 if(stale.ok!==false||stale.conflict!==true||Number(stale.revision)!==Number(afterWrite.revision))throw new Error('古いrevision拒否テスト失敗');
 const after=await loadV2(url,token),check=acceptanceSnapshot(after.payload);
 assertBusinessUnchanged(base,after.payload);
 if(Number(after.revision)!==Number(afterWrite.revision)||after.lastMutationId!==mutationId)throw new Error('拒否テスト後に状態が変化しました');
 if(!check.ok)throw new Error('受入チェック失敗: '+check.issues.join(', '));
 const sameMutationCount=(after.payload.auditLog||[]).filter(x=>x.mutationId===mutationId).length;
 if(sameMutationCount!==1)throw new Error('受入mutationが一意ではありません');
 return{ok:true,beforeRevision:before.revision,afterRevision:after.revision,mutationId,duplicateProtected:true,staleConflictProtected:true,counts:check.counts,confirmed};
}
