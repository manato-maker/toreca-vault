import{validateState}from'./core.js';
import{loadVaultV2,getVaultV2Config}from'./browser-sync.js';
import{saveV2}from'./api-client.js';

const clone=x=>structuredClone(x);
const text=x=>String(x||'').trim();
const norm=x=>text(x).normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g,' ');
const key=x=>text(x.applicationId||x.entryId||x.referenceId)||[norm(x.store),norm(x.title)].join('::');
const statusRank={応募前:0,応募済:1,落選:2,当選:2,購入済:3};
const finalStatus=x=>['当選','落選','購入済'].includes(text(x));
function mergeLottery(old,item){
 const oldRank=statusRank[old.status]??-1,newRank=statusRank[item.status]??-1;
 const protectOld=oldRank>newRank||(finalStatus(old.status)&&finalStatus(item.status)&&old.status!==item.status);
 const out={...old,...item,id:old.id||item.id||('lottery-'+crypto.randomUUID())};
 if(protectOld){
  out.status=old.status;
  for(const k of ['receiptStatus','receivedDate','shrinkStatus'])if(old[k]!=null)out[k]=old[k];
 }
 for(const k of ['deadline','resultDate','receiveDeadline','receivedDate','receiptStatus','shrinkStatus','memo'])if(!text(item[k])&&old[k]!=null)out[k]=old[k];
 return out;
}
export function applyLotteryBatch(state,items,mutationId){
 validateState(state);if(!mutationId)throw new Error('mutationId が必要です');if(!Array.isArray(items)||!items.length)throw new Error('抽選データがありません');
 const next=clone(state),map=new Map((next.lotteries||[]).map((x,i)=>[key(x),i]));
 for(const raw of items){const item=clone(raw);if(!text(item.title))throw new Error('抽選名が必要です');const k=key(item),i=map.get(k);if(i==null){item.id=item.id||('lottery-'+crypto.randomUUID());next.lotteries.push(item);map.set(k,next.lotteries.length-1)}else next.lotteries[i]=mergeLottery(next.lotteries[i],item)}
 if(JSON.stringify(next.lotteries)===JSON.stringify(state.lotteries))return clone(state);
 next.revision=Number(state.revision)+1;next.lastMutationId=mutationId;next.auditLog.push({mutationId,revision:next.revision,lotteriesUpdated:items.length});validateState(next);return next;
}
export async function commitV2LotteryBatch(items,config=getVaultV2Config()){
 const before=await loadVaultV2(config),mutationId='lottery-'+crypto.randomUUID(),next=applyLotteryBatch(before.payload,items,mutationId);
 if(JSON.stringify(before.payload.transactions)!==JSON.stringify(next.transactions)||JSON.stringify(before.payload.inventoryLots)!==JSON.stringify(next.inventoryLots)||JSON.stringify(before.payload.marketQuotes)!==JSON.stringify(next.marketQuotes))throw new Error('安全停止: 抽選以外のV2データが変化');
 if(Number(next.revision)===Number(before.payload.revision)&&next.lastMutationId===before.payload.lastMutationId)return{revision:before.revision,lotteries:before.payload.lotteries,unchanged:true};
 await saveV2(config.url,config.token,next,before.revision);const reread=await loadVaultV2(config);
 if(Number(reread.revision)!==Number(next.revision)||reread.lastMutationId!==mutationId)throw new Error('抽選保存後のrevision検証に失敗しました');
 if(JSON.stringify(reread.payload.transactions)!==JSON.stringify(before.payload.transactions)||JSON.stringify(reread.payload.inventoryLots)!==JSON.stringify(before.payload.inventoryLots)||JSON.stringify(reread.payload.marketQuotes)!==JSON.stringify(before.payload.marketQuotes))throw new Error('安全停止: 保存後に抽選以外が変化');
 return{revision:reread.revision,lotteries:reread.payload.lotteries,unchanged:false};
}
