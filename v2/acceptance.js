import{v2ViewModel,v2Assets,v2RealizedProfit}from'./view-model.js';
const qty=x=>Number(x?.quantity)||0;
export function acceptanceSnapshot(state){
 const view=v2ViewModel(state),assets=v2Assets(state);
 const byType=t=>(state.transactions||[]).filter(x=>x.type===t).length;
 const inventory=[...(view.boxes||[]),...(view.packs||[]),...(view.cards||[])];
 const canonicalLots=(state.inventoryLots||[]).filter(x=>qty(x)>0);
 const issues=[];
 if(view.purchases.length!==byType('purchase'))issues.push('purchase count mismatch');
 if(view.sales.length!==byType('sale'))issues.push('sale count mismatch');
 if(view.openings.length!==byType('opening'))issues.push('opening count mismatch');
 if(view.lotteries.length!==(state.lotteries||[]).length)issues.push('lottery count mismatch');
 if(inventory.length!==canonicalLots.length)issues.push('inventory record count mismatch');
 if(inventory.reduce((n,x)=>n+qty(x),0)!==canonicalLots.reduce((n,x)=>n+qty(x),0))issues.push('inventory quantity mismatch');
 if(inventory.some(x=>Object.hasOwn(x,'store')))issues.push('inventory store dimension leaked');
 return{ok:issues.length===0,issues,counts:{transactions:(state.transactions||[]).length,purchases:view.purchases.length,sales:view.sales.length,openings:view.openings.length,lotteries:view.lotteries.length,inventoryRecords:inventory.length,inventoryQuantity:inventory.reduce((n,x)=>n+qty(x),0)},assets,realizedProfit:v2RealizedProfit(state),revision:state.revision,lastMutationId:state.lastMutationId};
}

export function pendingMigrationSnapshot(state){
 const txIds=new Set((state.transactions||[]).map(x=>x.id));
 const lots=new Map((state.inventoryLots||[]).map(x=>[x.sourceTransactionId,x]));
 const requiredTx=['pending-joshin-deck-20260919','pending-joshin-30th-box-20260919','pending-plays-30th-box-20260920','pending-allium-30th-noshrink-20260920','pending-lawson-awajitomishima-packs-20260921','pending-lawson-awajitomishima-opening-20260921','pending-pull-charizard-137-20260921','pending-pull-pikachu-ex-127-20260921'];
 const requiredLots=['pending-joshin-deck-20260919','pending-plays-30th-box-20260920','pending-pull-charizard-137-20260921','pending-pull-pikachu-ex-127-20260921'];
 const missingTransactions=requiredTx.filter(id=>!txIds.has(id));
 const missingLots=requiredLots.filter(id=>!lots.has(id)||qty(lots.get(id))<=0);
 return{ok:missingTransactions.length===0&&missingLots.length===0,missingTransactions,missingLots,requiredTxCount:requiredTx.length,requiredLotCount:requiredLots.length};
}
