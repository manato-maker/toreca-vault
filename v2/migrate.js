import{emptyV2,validateState}from'./core.js';
const q=x=>Number(x?.quantity)||0;
const num=x=>{if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null};
const boxCondition=x=>{const raw=String(x.shrinkStatus||x.condition||'').trim();if(raw==='シュリンクあり'||raw==='あり')return'あり';if(raw==='シュリンクなし'||raw==='なし')return'なし';if(raw==='対象外')return'対象外';if(raw==='未開封')return'未開封';return''};
const condition=(x,category)=>category==='BOX'?boxCondition(x):String(x.condition||x.shrinkStatus||'').trim();
const migratedCategory=x=>/マクドナルド.*プロモ|プロモ.*マクドナルド/.test(String(x.product||''))?'パック':null;
const migratedCondition=(x,category)=>{const p=String(x.product||'');if(category==='BOX'&&/^スペシャルBOX/.test(p))return'未開封';if(category==='パック'&&/マクドナルド.*プロモ|プロモ.*マクドナルド/.test(p))return'未開封';if(category==='BOX'&&(/インフェルノX/.test(p)||/MEGAドリームex/.test(p)))return'あり';return condition(x,category)};
const productKey=x=>String(x.inventoryKey||x.productKey||x.product||'').trim();
const unitCost=x=>{const c=num(x.cost);return c===null?null:c};

export function migrateV1(root){
 const src=root?.data||root;if(!src)throw new Error('旧データがありません');const out=emptyV2();
 for(const p of src.purchases||[])out.transactions.push({...structuredClone(p),id:p.id,type:'purchase',productKey:productKey(p),condition:condition(p,p.category)});
 for(const s of src.sales||[])out.transactions.push({...structuredClone(s),id:s.id,type:'sale',productKey:productKey(s),condition:condition(s,s.category)});
 for(const o of src.openings||[])out.transactions.push({...structuredClone(o),id:o.id,type:'opening',productKey:productKey(o),condition:condition(o,'BOX')});
 for(const [legacyCategory,name] of [['BOX','boxes'],['パック','packs'],['カード','cards']])for(const x of src[name]||[]){
   if(q(x)<=0)continue;const category=migratedCategory(x)||legacyCategory;
   out.inventoryLots.push({id:'migrated-'+x.id,product:x.product,productKey:productKey(x),category,condition:migratedCondition(x,category),quantity:q(x),unitCost:unitCost(x),acquiredAt:x.date||'',sourceTransactionId:x.sourceId||'',legacyInventoryId:x.id});
 }
 out.lotteries=structuredClone(src.lotteries||[]);
 out.marketQuotes=[...(src.boxes||[]),...(src.packs||[]),...(src.cards||[])].filter(x=>q(x)>0&&num(x.marketPrice)!==null).map(x=>({product:x.product,productKey:productKey(x),category:(src.cards||[]).includes(x)?'カード':(src.packs||[]).includes(x)?'パック':'BOX',condition:condition(x,(src.cards||[]).includes(x)?'カード':(src.packs||[]).includes(x)?'パック':'BOX'),price:num(x.marketPrice),checkedAt:x.marketCheckedAt||'',source:x.marketSource||'',history:structuredClone(x.marketHistory||[]),legacyInventoryId:x.id}));
 validateState(out);return out;
}
export function migrationReport(oldRoot,v2){
 const s=oldRoot?.data||oldRoot;const sum=(a,f)=>a.reduce((n,x)=>n+(Number(f(x))||0),0);const inv=[...(s.boxes||[]),...(s.packs||[]),...(s.cards||[])].filter(x=>q(x)>0);
 const txCount=(s.purchases||[]).length+(s.sales||[]).length+(s.openings||[]).length;
 const duplicateIds=a=>{const seen=new Set(),dup=[];for(const x of a){if(!x.id||seen.has(x.id))dup.push(x.id||'(missing)');seen.add(x.id)}return dup};
 return {purchases:(s.purchases||[]).length,sales:(s.sales||[]).length,openings:(s.openings||[]).length,lotteries:(s.lotteries||[]).length,oldTransactionCount:txCount,v2Transactions:v2.transactions.length,oldInventoryRecords:inv.length,v2InventoryRecords:v2.inventoryLots.length,oldInventoryQty:sum(inv,x=>x.quantity),v2InventoryQty:sum(v2.inventoryLots,x=>x.quantity),v2Lotteries:v2.lotteries.length,duplicateLegacyTransactionIds:duplicateIds([...(s.purchases||[]),...(s.sales||[]),...(s.openings||[])]),duplicateV2TransactionIds:duplicateIds(v2.transactions)};
}
export function assertMigrationReconciled(oldRoot,v2){
 const r=migrationReport(oldRoot,v2);const failures=[];
 if(r.oldTransactionCount!==r.v2Transactions)failures.push('transaction count mismatch');
 if(r.oldInventoryRecords!==r.v2InventoryRecords)failures.push('inventory record count mismatch');
 if(r.oldInventoryQty!==r.v2InventoryQty)failures.push('inventory quantity mismatch');
 if(r.lotteries!==r.v2Lotteries)failures.push('lottery count mismatch');
 if(r.duplicateLegacyTransactionIds.length||r.duplicateV2TransactionIds.length)failures.push('duplicate transaction ids');
 if(failures.length)throw new Error('migration reconciliation failed: '+failures.join(', '));
 return r;
}
