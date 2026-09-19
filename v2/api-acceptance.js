import{loadV2,saveV2}from'./api-client.js';
import{acceptanceSnapshot}from'./acceptance.js';
const clone=x=>structuredClone(x);
export async function runSafeApiAcceptance(url,token){
 const before=await loadV2(url,token),base=clone(before.payload);
 const mutationId='acceptance-'+Date.now()+'-'+crypto.randomUUID();
 const next=clone(base);next.revision=Number(before.revision)+1;next.lastMutationId=mutationId;next.auditLog=[...(next.auditLog||[]),{mutationId,type:'acceptance',at:new Date().toISOString(),memo:'V2 API acceptance test — no business data changed'}];
 const confirmed=await saveV2(url,token,next,before.revision);
 const after=await loadV2(url,token),check=acceptanceSnapshot(after.payload);
 const businessKeys=['transactions','inventoryLots','lotteries','marketQuotes'];
 for(const k of businessKeys)if(JSON.stringify(base[k]||[])!==JSON.stringify(after.payload[k]||[]))throw new Error('受入試験で業務データが変化しました: '+k);
 if(!check.ok)throw new Error('受入チェック失敗: '+check.issues.join(', '));
 const sameMutationCount=(after.payload.auditLog||[]).filter(x=>x.mutationId===mutationId).length;
 if(sameMutationCount!==1)throw new Error('受入mutationが一意ではありません');
 return{ok:true,beforeRevision:before.revision,afterRevision:after.revision,mutationId,counts:check.counts,confirmed};
}
