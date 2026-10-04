import{getVaultV2Config}from'./browser-sync.js?v=20261004-livepocket-v1';
import{loadV2,saveV2}from'./api-client.js?v=20260930-jsonp-v1';

const STORM_REPAIR_ID='repair-storm-emeralda-zero-20261004';
const LIVEPOCKET_REPAIR_ID='repair-livepocket-recent-20261004';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　・_＿\-]/g,'');
const isStormBox=x=>Number(x?.quantity)>0&&norm(x?.product).includes(norm('ストームエメラルダ'))&&String(x?.category||'').toUpperCase()==='BOX';
const appendMemo=(value,parts)=>{
 const out=String(value||'').split('｜').map(x=>x.trim()).filter(Boolean);
 for(const p of parts){if(p&&!out.includes(p))out.push(p)}
 return out.join('｜');
};

async function repairStormEmeraldaGhostInventory(config){
 const before=await loadV2(config.url,config.token),state=before?.payload;
 if(!state||Number(state.schemaVersion)!==2)return false;
 const audits=Array.isArray(state.auditLog)?state.auditLog:[];
 if(audits.some(x=>x?.mutationId===STORM_REPAIR_ID))return false;
 const targets=(state.inventoryLots||[]).filter(isStormBox),total=targets.reduce((s,x)=>s+Number(x.quantity||0),0);
 if(total===0)return false;
 if(total!==1){console.warn('[Toreca Vault] ストームエメラルダ在庫補正を停止: 表示在庫が1点ではありません',total);return false}
 const next=structuredClone(state),ids=new Set(targets.map(x=>String(x.id||'')));
 for(const lot of next.inventoryLots||[]){if(ids.has(String(lot.id||'')))lot.quantity=0}
 next.marketQuotes=(next.marketQuotes||[]).filter(q=>!ids.has(String(q.lotId||'')));
 next.revision=Number(before.revision)+1;
 next.lastMutationId=STORM_REPAIR_ID;
 next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];
 next.auditLog.push({mutationId:STORM_REPAIR_ID,revision:next.revision,type:'inventory-correction',at:new Date().toISOString(),product:'ストームエメラルダ',quantityDelta:-1,reason:'ユーザー確認: 現物在庫0だが1点表示'});
 await saveV2(config.url,config.token,next,before.revision);
 const check=await loadV2(config.url,config.token),remaining=(check?.payload?.inventoryLots||[]).filter(isStormBox).reduce((s,x)=>s+Number(x.quantity||0),0);
 if(remaining!==0)throw new Error('ストームエメラルダ在庫補正後の再読込検証に失敗しました');
 return true;
}

function livePocketMatch(item,spec){
 const hay=[item?.id,item?.memo,item?.gmailMessageId].map(x=>String(x||'')).join('｜');
 return hay.includes(spec.applicationNo)||hay.includes(spec.gmailMessageId);
}

function upsertLivePocketLottery(state,spec,now){
 state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
 const matches=state.lotteries.filter(x=>livePocketMatch(x,spec));
 let item=matches[0];
 if(!item){
  item={id:'lottery-livepocket-'+spec.applicationNo,title:spec.title,store:spec.store,status:'応募済',deadline:'',resultDate:spec.resultDate,receiveDeadline:'',receiptStatus:'対象外',receivedDate:'',shrinkStatus:'未選択',memo:'',applicationDate:spec.applicationDate,source:'gmail/livepocket',gmailMessageId:spec.gmailMessageId,createdAt:now,updatedAt:now};
  state.lotteries.push(item);
 }else if(matches.length>1){
  const removeIds=new Set(matches.slice(1).map(x=>String(x.id||'')));
  for(const dup of matches.slice(1)){
   if(!item.applicationDate&&dup.applicationDate)item.applicationDate=dup.applicationDate;
   if(!item.createdAt&&dup.createdAt)item.createdAt=dup.createdAt;
   if(dup.memo)item.memo=appendMemo(item.memo,String(dup.memo).split('｜'));
  }
  state.lotteries=state.lotteries.filter(x=>!removeIds.has(String(x.id||'')));
 }
 item.title=spec.title;
 item.store=spec.store;
 if(!['当選','落選','購入済'].includes(String(item.status||'')))item.status='応募済';
 item.resultDate=spec.resultDate;
 if(!item.applicationDate)item.applicationDate=spec.applicationDate;
 if(!item.receiptStatus)item.receiptStatus=item.status==='当選'?'未受取':item.status==='購入済'?'受取済み':'対象外';
 item.gmailMessageId=spec.gmailMessageId;
 item.source=item.source||'gmail/livepocket';
 item.memo=appendMemo(item.memo,['LivePocket','申込番号 '+spec.applicationNo,spec.note]);
 item.updatedAt=now;
 return item;
}

async function repairRecentLivePocket(config){
 const before=await loadV2(config.url,config.token),state=before?.payload;
 if(!state||Number(state.schemaVersion)!==2)return false;
 const audits=Array.isArray(state.auditLog)?state.auditLog:[];
 if(audits.some(x=>x?.mutationId===LIVEPOCKET_REPAIR_ID))return false;
 const specs=[
  {applicationNo:'1054301100',gmailMessageId:'1a1045fa729f0163',applicationDate:'2026-10-04',resultDate:'2026-10-10',store:'イエローサブマリン',title:'ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX',note:'落選者専用 10月再販｜イベント 10/11〜10/13'},
  {applicationNo:'1053491691',gmailMessageId:'1a0fad0e9aa3fd4b',applicationDate:'2026-10-02',resultDate:'2026-10-09',store:"ホビーステーション日本橋2's店",title:'ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX',note:'再販｜イベント 10/12〜10/18'}
 ];
 const next=structuredClone(state),now=new Date().toISOString();
 for(const spec of specs)upsertLivePocketLottery(next,spec,now);
 next.revision=Number(before.revision)+1;
 next.lastMutationId=LIVEPOCKET_REPAIR_ID;
 next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];
 next.auditLog.push({mutationId:LIVEPOCKET_REPAIR_ID,revision:next.revision,type:'lottery-repair',at:now,reason:'Gmail確認済みLivePocket応募2件を申込番号で補完・重複整理',applications:specs.map(x=>x.applicationNo)});
 await saveV2(config.url,config.token,next,before.revision);
 const check=await loadV2(config.url,config.token),lotteries=check?.payload?.lotteries||[];
 for(const spec of specs){
  const matches=lotteries.filter(x=>livePocketMatch(x,spec));
  if(matches.length!==1||String(matches[0].resultDate||'').slice(0,10)!==spec.resultDate||norm(matches[0].store)!==norm(spec.store))throw new Error('LivePocket補正後の再読込検証に失敗しました: '+spec.applicationNo);
 }
 return true;
}

async function runOneTimeRepairs(){
 const config=getVaultV2Config();
 if(!config.url||!config.token)return;
 let changed=false;
 changed=await repairStormEmeraldaGhostInventory(config)||changed;
 changed=await repairRecentLivePocket(config)||changed;
 if(changed)location.reload();
}

runOneTimeRepairs().catch(err=>console.error('[Toreca Vault] one-time repair failed',err));
