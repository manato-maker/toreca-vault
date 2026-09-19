import{emptyV2,validateState}from'./core.js';
const q=x=>Number(x?.quantity)||0;
export function migrateV1(root){
 const src=root?.data||root;if(!src)throw new Error('旧データがありません');const out=emptyV2();
 for(const p of src.purchases||[])out.transactions.push({...p,id:p.id,type:'purchase',condition:p.shrinkStatus||''});
 for(const s of src.sales||[])out.transactions.push({...s,id:s.id,type:'sale',condition:s.shrinkStatus||''});
 for(const o of src.openings||[])out.transactions.push({...o,id:o.id,type:'opening',condition:o.shrinkStatus||''});
 for(const [category,name] of [['BOX','boxes'],['パック','packs'],['カード','cards']])for(const x of src[name]||[]){if(q(x)<=0)continue;out.inventoryLots.push({id:'migrated-'+x.id,product:x.product,productKey:x.inventoryKey||x.product,category,condition:x.shrinkStatus||'',quantity:q(x),unitCost:Number(x.cost)||0,acquiredAt:x.date||'',sourceTransactionId:x.sourceId||''})}
 out.lotteries=structuredClone(src.lotteries||[]);validateState(out);return out;
}
export function migrationReport(oldRoot,v2){
 const s=oldRoot?.data||oldRoot;const sum=(a,f)=>a.reduce((n,x)=>n+(Number(f(x))||0),0);
 return {purchases:(s.purchases||[]).length,sales:(s.sales||[]).length,lotteries:(s.lotteries||[]).length,oldInventoryQty:sum([...(s.boxes||[]),...(s.packs||[]),...(s.cards||[])],x=>x.quantity),v2Transactions:v2.transactions.length,v2InventoryQty:sum(v2.inventoryLots,x=>x.quantity),v2Lotteries:v2.lotteries.length};
}
