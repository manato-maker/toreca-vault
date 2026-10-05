import{validateState,applyTransaction}from'./core.js';
import{retailPriceInfo}from'./retail-price.js';
import{loadVaultV2,getVaultV2Config}from'./browser-sync.js';
import{saveV2}from'./api-client.js';
import{assertV2WriteEnabled}from'./write-gate.js';

const clone=x=>structuredClone(x);
const text=x=>String(x||'').trim();
function verifyPersistedMutation(reread,nextRevision,mutationId,label){const revision=Number(reread?.revision),expected=Number(nextRevision),audits=(reread?.payload?.auditLog||[]).filter(x=>x.mutationId===mutationId);if(!Number.isFinite(revision)||revision<expected||audits.length!==1)throw new Error(label+'の保存検証に失敗しました');return revision}
const norm=x=>text(x).normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g,' ');
const key=x=>text(x.applicationId||x.entryId||x.referenceId)||[norm(x.store),norm(x.title)].join('::');
const statusRank={応募前:0,応募済:1,落選:2,当選:2,購入済:3};
const contradictoryResult=(a,b)=>['当選','落選'].includes(text(a))&&['当選','落選'].includes(text(b))&&text(a)!==text(b);
function mergeLottery(old,item){
 const oldRank=statusRank[old.status]??-1,newRank=statusRank[item.status]??-1;
 const protectOld=oldRank>newRank||contradictoryResult(old.status,item.status);
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
 verifyPersistedMutation(reread,next.revision,mutationId,'抽選');
 if(JSON.stringify(reread.payload.transactions)!==JSON.stringify(before.payload.transactions)||JSON.stringify(reread.payload.inventoryLots)!==JSON.stringify(before.payload.inventoryLots)||JSON.stringify(reread.payload.marketQuotes)!==JSON.stringify(before.payload.marketQuotes))throw new Error('安全停止: 保存後に抽選以外が変化');
 return{revision:reread.revision,lotteries:reread.payload.lotteries,unchanged:false};
}


const manualFields=new Set(['status','receiptStatus','receivedDate','shrinkStatus','receiptPhoto','memo']);
export function applyLotteryManualPatches(state,patches,mutationId){
 validateState(state);if(!mutationId)throw new Error('mutationId が必要です');if(!Array.isArray(patches)||!patches.length)throw new Error('変更対象がありません');
 const next=clone(state),byId=new Map((next.lotteries||[]).map(x=>[text(x.id),x]));let updated=0;
 for(const raw of patches){
  const id=text(raw&&raw.id),item=byId.get(id);if(!id||!item)throw new Error('抽選データが見つかりません: '+id);
  const before=JSON.stringify(item);
  for(const [k,v] of Object.entries(raw||{}))if(manualFields.has(k))item[k]=v;
  if(raw.status==='落選'){item.receiptStatus='対象外';item.receivedDate=''}
  else if(raw.status==='当選'&&item.receiptStatus!=='受取済み')item.receiptStatus='未受取';
  else if(raw.status==='購入済'){item.receiptStatus='受取済み';if(!text(item.receivedDate))item.receivedDate=new Date().toISOString().slice(0,10)}
  item.updatedAt=new Date().toISOString();
  if(JSON.stringify(item)!==before)updated++;
 }
 if(!updated)return clone(state);
 next.revision=Number(state.revision)+1;next.lastMutationId=mutationId;next.auditLog.push({mutationId,revision:next.revision,lotteriesManuallyUpdated:updated});validateState(next);return next;
}
export async function commitV2LotteryManualPatches(patches,config=getVaultV2Config()){
 const before=await loadVaultV2(config),mutationId='lottery-manual-'+crypto.randomUUID(),next=applyLotteryManualPatches(before.payload,patches,mutationId);
 if(JSON.stringify(before.payload.transactions)!==JSON.stringify(next.transactions)||JSON.stringify(before.payload.inventoryLots)!==JSON.stringify(next.inventoryLots)||JSON.stringify(before.payload.marketQuotes)!==JSON.stringify(next.marketQuotes))throw new Error('安全停止: 抽選以外のV2データが変化');
 if(Number(next.revision)===Number(before.payload.revision)&&next.lastMutationId===before.payload.lastMutationId)return{revision:before.revision,payload:before.payload,updated:0,unchanged:true};
 await saveV2(config.url,config.token,next,before.revision);const reread=await loadVaultV2(config);
 verifyPersistedMutation(reread,next.revision,mutationId,'抽選手動更新');
 if(JSON.stringify(reread.payload.transactions)!==JSON.stringify(before.payload.transactions)||JSON.stringify(reread.payload.inventoryLots)!==JSON.stringify(before.payload.inventoryLots)||JSON.stringify(reread.payload.marketQuotes)!==JSON.stringify(before.payload.marketQuotes))throw new Error('安全停止: 保存後に抽選以外が変化');
 return{revision:reread.revision,payload:reread.payload,updated:patches.length,unchanged:false};
}


const receiptCondition=(category,shrink)=>category!=='BOX'?'':({'シュリンクあり':'あり','シュリンクなし':'なし','対象外':'対象外','あり':'あり','なし':'なし'}[text(shrink)]||'未開封');
export function applyLotteryReceiptPurchase(state,input,mutationId){
 validateState(state);if(!mutationId)throw new Error('mutationId が必要です');
 const data=input&&typeof input==='object'?input:{},id=text(data.id),next=clone(state),item=(next.lotteries||[]).find(x=>text(x.id)===id);
 if(!item)throw new Error('対象の抽選データが見つかりません');
 const receivedDate=text(data.receivedDate),product=text(data.product||item.title),store=text(data.store||item.store),category=text(data.category||'BOX'),quantity=Number(data.quantity||1),enteredTotal=Number(data.total||0),addPurchase=data.addPurchase!==false;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate))throw new Error('受取日が不正です');
 if(!product||!store)throw new Error('商品名・店舗名が必要です');
 if(!['BOX','パック','カード'].includes(category))throw new Error('購入種別が不正です');
 if(!Number.isInteger(quantity)||quantity<=0)throw new Error('数量は正の整数が必要です');
 const retail=category==='カード'?null:retailPriceInfo(product,category),accountingTotal=retail?retail.price*quantity:enteredTotal;
 if(addPurchase&&category==='カード'&&(!Number.isFinite(enteredTotal)||enteredTotal<=0))throw new Error('購入合計金額を入力してください');
 if(addPurchase&&category!=='カード'&&!retail)throw new Error('定価未登録の商品です。公式価格を確認して定価マスターへ追加してください');
 item.status='購入済';item.receiptStatus='受取済み';item.receivedDate=receivedDate;item.shrinkStatus=text(data.shrinkStatus||item.shrinkStatus||'未選択');
 if(data.receiptPhoto)item.receiptPhoto=data.receiptPhoto;
 if(Number.isFinite(enteredTotal)&&enteredTotal>=0)item.receiptPaidAmount=enteredTotal;item.receiptAmount=retail?accountingTotal:(Number.isFinite(enteredTotal)&&enteredTotal>0?enteredTotal:item.receiptAmount);if(retail){item.receiptPriceBasis='希望小売価格';item.retailPriceSource=retail.source;}
 item.receiptProduct=product;item.receiptStore=store;item.receiptQuantity=quantity;item.receiptCategory=category;item.updatedAt=new Date().toISOString();
 const txId='lottery-receipt-purchase-'+id;
 if(addPurchase){
  const price=accountingTotal/quantity,existing=next.transactions.find(x=>x.id===txId);
  if(existing){
   const same=text(existing.product)===product&&text(existing.store)===store&&text(existing.date)===receivedDate&&Number(existing.quantity)===quantity&&Number(existing.price)===price&&text(existing.category)===category;
   if(!same)throw new Error('この抽選の購入履歴は既に登録済みです。購入履歴への追加をOFFにして受取情報だけ更新してください');
  }else{
   const tx={id:txId,type:'purchase',product,productKey:product,store,date:receivedDate,quantity,price,total:accountingTotal,category,condition:receiptCondition(category,data.shrinkStatus),sourceLotteryId:id,memo:'抽選受取｜レシート確認'};if(retail){tx.priceBasis='希望小売価格';tx.retailPriceSource=retail.source;if(Number.isFinite(enteredTotal)&&enteredTotal>=0&&enteredTotal!==accountingTotal){tx.actualPaid=enteredTotal/quantity;tx.actualPaidTotal=enteredTotal;}}
   const applied=applyTransaction(next,tx,mutationId+'-purchase');
   next.transactions=applied.transactions;next.inventoryLots=applied.inventoryLots;next.auditLog=applied.auditLog;
  }
 }
 next.revision=Number(state.revision)+1;next.lastMutationId=mutationId;
 next.auditLog.push({mutationId,revision:next.revision,lotteryReceiptId:id,purchaseTransactionId:addPurchase?txId:'',kind:'lottery-receipt'});
 for(const a of next.auditLog)if(a.mutationId===mutationId+'-purchase')a.revision=next.revision;
 validateState(next);return next;
}
export async function commitV2LotteryReceiptPurchase(input,config=getVaultV2Config()){
 const before=await loadVaultV2(config);assertV2WriteEnabled(before.revision);
 const mutationId='lottery-receipt-'+crypto.randomUUID(),next=applyLotteryReceiptPurchase(before.payload,input,mutationId);
 await saveV2(config.url,config.token,next,before.revision);const reread=await loadVaultV2(config);
 const item=reread.payload.lotteries.find(x=>text(x.id)===text(input.id));
 if(!item||item.status!=='購入済'||item.receiptStatus!=='受取済み')throw new Error('受取情報の保存確認に失敗しました');
 if(input.addPurchase!==false){
  const txId='lottery-receipt-purchase-'+text(input.id);
  if(reread.payload.transactions.filter(x=>x.id===txId).length!==1)throw new Error('購入履歴の一意性確認に失敗しました');
 }
 verifyPersistedMutation(reread,next.revision,mutationId,'受取');
 return{revision:reread.revision,payload:reread.payload,lottery:item};
}
