import{getVaultV2Config}from'./browser-sync.js?v=20261004-storm-zero-v1';
import{loadV2,saveV2}from'./api-client.js?v=20260930-jsonp-v1';

const REPAIR_ID='repair-storm-emeralda-zero-20261004';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　・_＿\-]/g,'');
const isStormBox=x=>Number(x?.quantity)>0&&norm(x?.product).includes(norm('ストームエメラルダ'))&&String(x?.category||'').toUpperCase()==='BOX';

async function repairStormEmeraldaGhostInventory(){
 const config=getVaultV2Config();
 if(!config.url||!config.token)return;
 const before=await loadV2(config.url,config.token),state=before?.payload;
 if(!state||Number(state.schemaVersion)!==2)return;
 const audits=Array.isArray(state.auditLog)?state.auditLog:[];
 if(audits.some(x=>x?.mutationId===REPAIR_ID))return;
 const targets=(state.inventoryLots||[]).filter(isStormBox),total=targets.reduce((s,x)=>s+Number(x.quantity||0),0);
 if(total===0)return;
 if(total!==1){console.warn('[Toreca Vault] ストームエメラルダ在庫補正を停止: 表示在庫が1点ではありません',total);return}
 const next=structuredClone(state),ids=new Set(targets.map(x=>String(x.id||'')));
 for(const lot of next.inventoryLots||[]){if(ids.has(String(lot.id||'')))lot.quantity=0}
 next.marketQuotes=(next.marketQuotes||[]).filter(q=>!ids.has(String(q.lotId||'')));
 next.revision=Number(before.revision)+1;
 next.lastMutationId=REPAIR_ID;
 next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];
 next.auditLog.push({mutationId:REPAIR_ID,revision:next.revision,type:'inventory-correction',at:new Date().toISOString(),product:'ストームエメラルダ',quantityDelta:-1,reason:'ユーザー確認: 現物在庫0だが1点表示'});
 await saveV2(config.url,config.token,next,before.revision);
 const check=await loadV2(config.url,config.token),remaining=(check?.payload?.inventoryLots||[]).filter(isStormBox).reduce((s,x)=>s+Number(x.quantity||0),0);
 if(remaining!==0)throw new Error('ストームエメラルダ在庫補正後の再読込検証に失敗しました');
 location.reload();
}

repairStormEmeraldaGhostInventory().catch(err=>console.error('[Toreca Vault] one-time inventory repair failed',err));
