// Fixed MSRP accounting for all non-single purchases; actual paid amount is retained separately.
// v2 also processes idempotent pack-opening, exact lottery-result, and exact lottery-patch commands before the generic Gmail command router.
const TV2_RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v2';
const TV2_RETAIL_PRICE_CATALOG=[
 {test:/30th celebration.*カードセット.*9種|カードセット.*9種/i,fixed:10800,source:'ポケモンカード公式 30周年商品（9種セット）'},
 {test:/30th celebration.*futuristic box|futuristic box/i,fixed:27500,source:'ポケモンカード公式 30周年商品'},
 {test:/30th celebration.*プレミアムデッキセット|プレミアムデッキセット.*エーフィ.*ブラッキー/i,fixed:6200,source:'ポケモンカード公式 商品情報'},
 {test:/30th celebration.*カードセット/i,fixed:1200,source:'ポケモンカード公式 30周年商品'},
 {test:/スペシャルbox ポケモンセンター(?:トウホク|フクオカ|ヒロシマ)/i,fixed:2090,source:'ポケモンカード公式 商品情報'},
 {test:/スタートデッキ100.*バトルコレクション|mega スタートデッキ100/i,fixed:891,source:'ポケモンカード公式 商品情報'},
 {test:/30th celebration/i,pack:360,box:7200,source:'ポケモンカード公式 30周年商品'},
 {test:/ストームエメラルダ/,pack:200,box:6000,source:'ポケモンカード公式'},
 {test:/アビスアイ/,pack:200,box:6000,source:'ポケモンカード公式'},
 {test:/ニンジャスピナー/,pack:180,box:5400,source:'ポケモンカード公式'},
 {test:/ムニキスゼロ/,pack:180,box:5400,source:'ポケモンカード公式'},
 {test:/megaドリームex/i,pack:550,box:5500,source:'ポケモンカード公式（1パック550円・BOX10パック換算）'},
 {test:/インフェルノx/i,pack:180,box:5400,source:'ポケモンカード公式'},
 {test:/メガブレイブ|メガシンフォニア/,pack:180,box:5400,source:'ポケモンカード公式'},
 {test:/ブラックボルト(?!.*デラックス)/,pack:290,box:5800,source:'ポケモンカード公式（1パック290円・BOX20パック換算）'},
 {test:/brightness of hope/i,pack:240,box:5760,source:'ドラゴンボール フュージョンワールド公式'},
 {test:/決戦の刻.*op-?16|op-?16.*決戦の刻/i,pack:220,box:5280,source:'ONE PIECE公式（1パック220円・BOX24パック換算）'},
 {test:/世界最強の戦士.*op-?17|op-?17.*世界最強の戦士/i,pack:240,box:5760,source:'BANDAI公式（1パック240円・BOX24パック換算）'}
];
function tv2RetailPriceInfo_(product,category,quantity){
 const c=String(category||'').trim(),n=String(product||'').normalize('NFKC').replace(/\s+/g,' ').trim();if(!n||c==='カード')return null;
 const hit=TV2_RETAIL_PRICE_CATALOG.find(x=>x.test.test(n));if(!hit)return null;
 let price;if(hit.fixed!=null)price=hit.fixed;else if(c==='パック')price=hit.pack;else if(c==='BOX')price=hit.box;else{
  const q=Number(quantity)||1,m=n.match(/(?:^|\D)(\d+)\s*box分/i);
  if(m&&q===1)price=hit.box*Number(m[1]);else if(/box|ボックス|シュリンク|テープ/i.test(n))price=hit.box;else if(q>=5)price=hit.pack;else price=hit.box;
 }
 return Number.isFinite(price)?{price,source:hit.source,basis:'希望小売価格'}:null;
}
function tv2PackOpenNormalize_(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s　「」『』()（）\-‐‑‒–—―・]/g,'')}
function tv2ProcessPackOpeningDrafts_(){
 const subject='[Toreca Vault Command]',results=[];
 const drafts=tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject);
 drafts.forEach(draft=>{
  try{
   const raw=String(tv2DraftPlainBody_(draft)||'').trim();let command;try{command=JSON.parse(raw)}catch(e){return}
   if(String(command&&command.type||'')!=='open-packs')return;
   const requestId=String(command.requestId||'').trim(),product=String(command.product||'').trim(),store=String(command.store||'').trim(),date=String(command.date||Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')).trim(),quantity=Number(command.quantity),memo=String(command.memo||'パック開封｜シングル登録なし').trim();
   if(!requestId||!product||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(quantity)||quantity<=0)throw new Error('パック開封コマンドが不正です');
   const sourceIds=(Array.isArray(command.sourcePurchaseRequestIds)?command.sourcePurchaseRequestIds:[command.sourcePurchaseRequestId]).filter(Boolean).map(String);
   const result=tv2Mutate_('chat-open-packs',state=>{
    state.transactions=Array.isArray(state.transactions)?state.transactions:[];state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
    const openingId='chat-opening-'+requestId,existing=state.transactions.filter(t=>String(t.id||'')===openingId);
    if(existing.length===1)return{changed:false,duplicate:true,openingId};
    if(existing.length>1)throw new Error('同一パック開封IDが重複しています');
    const wanted=tv2PackOpenNormalize_(product),wantedStore=tv2PackOpenNormalize_(store);
    let lots=state.inventoryLots.filter(l=>{
     if(String(l.category||'')!=='パック'||Number(l.quantity)<=0)return false;
     if(String(l.acquiredAt||'')!==date)return false;
     const name=tv2PackOpenNormalize_(l.productKey||l.product),shop=tv2PackOpenNormalize_(l.store||'');
     if(!(name===wanted||name.includes(wanted)||wanted.includes(name)))return false;
     return !wantedStore||shop===wantedStore;
    });
    if(sourceIds.length){const preferred=lots.filter(l=>sourceIds.includes(String(l.requestId||'')));if(preferred.length)lots=preferred}
    if(lots.length!==1)throw new Error(lots.length?'開封対象パック在庫が複数あるため特定できません':'V2正本に開封対象パック在庫がありません');
    const lot=lots[0];if(Number(lot.quantity)<quantity)throw new Error('開封数がV2正本のパック在庫を超えています');
    const info=tv2RetailPriceInfo_(product,'パック',quantity),unit=info?info.price:Number(lot.unitCost),cost=Number.isFinite(unit)?unit*quantity:null;
    lot.quantity=Number(lot.quantity)-quantity;state.inventoryLots=state.inventoryLots.filter(l=>Number(l.quantity)>0);
    const tx={id:openingId,type:'opening',product,productKey:product,category:'パック',condition:'開封済み',quantity,price:0,total:0,date,store:String(lot.store||store),source:'chat',requestId,memo,acquisitionCost:cost};
    if(info){tx.acquisitionCostBasis='希望小売価格';tx.retailPriceSource=info.source}
    state.transactions.push(tx);
    return{changed:true,duplicate:false,openingId,quantity,acquisitionCost:cost};
   });
   tv2DeleteDraft_(draft);results.push({ok:true,requestId,result});
  }catch(err){results.push({ok:false,error:String(err&&err.message||err)})}
 });
 return results;
}
function tv2LotteryExactNormalize_(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s　「」『』()（）\[\]【】<>＜＞\-‐‑‒–—―・･:：]/g,'')}
function tv2LotteryStoreNormalize_(value){
 const n=tv2LotteryExactNormalize_(value),k=tv2LotteryExactNormalize_('橿原');
 if(n.includes(k)&&(n.includes(tv2LotteryExactNormalize_('トレカキャピタル'))||n.includes(tv2LotteryExactNormalize_('エディオン'))))return'edion-kashihara-toreca-capital';
 return n;
}
function tv2ProcessConfirmedEdionDrafts_(){
 const subject='[Toreca Vault Command]',results=[];
 const drafts=tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject);
 drafts.forEach(draft=>{
  try{
   const raw=String(tv2DraftPlainBody_(draft)||'').trim();let command;try{command=JSON.parse(raw)}catch(e){return}
   if(String(command&&command.type||'')!=='lottery-edion-confirmed-win')return;
   const requestId=String(command.requestId||'').trim(),title=String(command.title||'').trim(),store=String(command.store||'').trim(),owner=String(command.owner||'本人').trim(),resultDate=String(command.resultDate||'').trim(),receiveDeadline=String(command.receiveDeadline||'').trim(),referenceId=String(command.referenceId||'').trim(),memo=String(command.memo||'').trim();
   const quantity=Number(command.quantity||2);
   if(!requestId||!title||!store||owner!=='本人'||!/^\d{4}-\d{2}-\d{2}$/.test(resultDate)||!/^\d{4}-\d{2}-\d{2}$/.test(receiveDeadline)||!Number.isInteger(quantity)||quantity<=0)throw new Error('エディオン当選確定コマンドが不正です');
   const n=tv2LotteryExactNormalize_,sn=tv2LotteryStoreNormalize_,wantedOwner=n(owner),wantedRef=n(referenceId);
   const productMatch=item=>{const t=n(item&&item.title||'');return t.includes(n('30th CELEBRATION'))&&(t.includes(n('カードセット'))||t.includes(n('9種')))};
   const aliasKey=sn('トレカ・キャピタル エディオンイオンモール橿原店');
   const edionMatch=item=>sn(item&&item.store||'')===aliasKey;
   const kashiharaMatch=edionMatch;
   const ownerCompatible=item=>{const o=n(item&&item.owner||'');if(/嫁|妻/.test(String(item&&item.owner||''))||/嫁分|妻分|奥さん/.test(String(item&&item.memo||'')))return false;return !o||o===wantedOwner||o===n('本人分')};
   const dateCompatible=item=>{const d=String(item&&item.resultDate||'').slice(0,10);return !d||d===resultDate};
   const result=tv2Mutate_('chat-lottery-edion-confirmed-win',state=>{
    state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
    const broad=state.lotteries.filter(item=>productMatch(item)&&edionMatch(item)&&ownerCompatible(item)&&dateCompatible(item));
    const local=broad.filter(kashiharaMatch),byRef=wantedRef?broad.filter(item=>n(item.memo||'').includes(wantedRef)):[];
    let item=null,created=false;
    if(byRef.length===1)item=byRef[0];
    else if(byRef.length>1)throw new Error('エディオン照合ID一致候補が複数あります');
    else if(local.length===1)item=local[0];
    else if(local.length>1)throw new Error('エディオン橿原の既存抽選が複数あります');
    else if(broad.length===0){
     const now=new Date().toISOString(),id='lottery-edion-kashihara-'+resultDate.replace(/-/g,'')+(referenceId?'-'+referenceId:'');
     if(state.lotteries.some(x=>String(x.id||'')===id))throw new Error('エディオン当選用IDが既に存在します');
     item={id,title,store,status:'当選',resultDate,receiveDeadline,receiptStatus:'未受取',receivedDate:'',owner,memo:'',source:'chat',requestId,createdAt:now,updatedAt:now};
     state.lotteries.push(item);created=true;
    }else{
     const generic=broad.filter(x=>{const s=n(x.store||'');return s===n('エディオン')||!s});
     if(generic.length===1)item=generic[0];
     else throw new Error('別店舗を含むエディオン既存候補があり自動確定を停止しました');
    }
    const before=JSON.stringify(item),now=new Date().toISOString();
    if(item.status==='購入済'||item.receiptStatus==='受取済み'){item.status='購入済';item.receiptStatus='受取済み'}else{item.status='当選';item.receiptStatus='未受取'}
    item.title=title;item.store=store;item.owner=owner;item.resultDate=resultDate;item.receiveDeadline=receiveDeadline;
    const parts=[memo,'当選数量 '+quantity+'セット',referenceId?'照合ID '+referenceId:''].filter(Boolean),existing=String(item.memo||'').split('｜').map(x=>x.trim()).filter(Boolean);
    parts.forEach(part=>{if(!existing.includes(part))existing.push(part)});item.memo=existing.join('｜');item.updatedAt=now;item.requestId=item.requestId||requestId;
    return{changed:created||JSON.stringify(item)!==before,created,lotteryId:String(item.id||''),status:item.status,resultDate:item.resultDate,receiveDeadline:item.receiveDeadline,title:item.title,store:item.store,owner:item.owner,quantity};
   });
   const check=tv2Load_(),state=check.payload||{},matches=(state.lotteries||[]).filter(x=>String(x.id||'')===String(result.lotteryId||''));
   if(matches.length!==1)throw new Error('エディオン当選の再読込で対象を一意確認できません');
   const item=matches[0];
   if(!['当選','購入済'].includes(String(item.status||''))||String(item.resultDate||'').slice(0,10)!==resultDate||String(item.receiveDeadline||'').slice(0,10)!==receiveDeadline||!kashiharaMatch(item)||!productMatch(item)||!ownerCompatible(item))throw new Error('エディオン当選の再読込検証に失敗しました');
   const allSame=(state.lotteries||[]).filter(x=>productMatch(x)&&edionMatch(x)&&kashiharaMatch(x)&&ownerCompatible(x)&&dateCompatible(x));
   if(allSame.length!==1)throw new Error('エディオン当選の重複検証に失敗しました: '+allSame.length+'件');
   const cleanupIds=new Set([requestId,String(command.cleanupRequestId||'')].filter(Boolean));
   tv2GetDrafts_().forEach(d=>{try{if(String(tv2DraftSubject_(d)||'').trim()!==subject)return;const c=JSON.parse(String(tv2DraftPlainBody_(d)||'').trim());if(cleanupIds.has(String(c&&c.requestId||'')))tv2DeleteDraft_(d)}catch(e){}});
   const resultSubject='[Toreca Vault Lottery Result] '+requestId,to=Session.getEffectiveUser().getEmail();
   tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===resultSubject).forEach(d=>tv2DeleteDraft_(d));
   if(to)tv2CreateDraft_(to,resultSubject,JSON.stringify({ok:true,requestId,revision:Number(check.revision),result,lottery:{id:item.id,title:item.title,store:item.store,owner:item.owner,status:item.status,resultDate:item.resultDate,receiveDeadline:item.receiveDeadline,memo:item.memo}},null,2));
   results.push({ok:true,requestId,revision:Number(check.revision),result});
  }catch(err){results.push({ok:false,error:String(err&&err.message||err)})}
 });
 return results;
}
function tv2ProcessExactLotteryPatchDrafts_(){
 const subject='[Toreca Vault Command]',results=[];
 const drafts=tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject);
 drafts.forEach(draft=>{
  try{
   const raw=String(tv2DraftPlainBody_(draft)||'').trim();let command;try{command=JSON.parse(raw)}catch(e){return}
   if(String(command&&command.type||'')!=='lottery-patch-exact')return;
   const requestId=String(command.requestId||'').trim(),matchTitle=String(command.matchTitle||command.title||'').trim(),store=String(command.store||'').trim(),owner=String(command.owner||'').trim(),resultDate=String(command.resultDate||'').trim(),applicationDate=String(command.applicationDate||'').trim(),newTitle=String(command.newTitle||'').trim(),deadline=String(command.deadline||'').trim(),receiveDeadline=String(command.receiveDeadline||'').trim(),memo=String(command.memo||'').trim();
   if(!requestId||!matchTitle||!store||!newTitle||!/^\d{4}-\d{2}-\d{2}$/.test(resultDate))throw new Error('抽選patch exactコマンドが不正です');
   if(applicationDate&&!/^\d{4}-\d{2}-\d{2}$/.test(applicationDate))throw new Error('抽選patch exact応募日が不正です');
   if(deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(deadline))throw new Error('抽選patch exact締切日が不正です');
   if(receiveDeadline&&!/^\d{4}-\d{2}-\d{2}$/.test(receiveDeadline))throw new Error('抽選patch exact購入日が不正です');
   const wantedTitle=tv2LotteryExactNormalize_(matchTitle),wantedStore=tv2LotteryStoreNormalize_(store),wantedOwner=tv2LotteryExactNormalize_(owner);
   const result=tv2Mutate_('chat-lottery-patch-exact',state=>{
    state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
    const matches=state.lotteries.filter(item=>{
     const itemTitle=tv2LotteryExactNormalize_(item.title||''),itemStore=tv2LotteryStoreNormalize_(item.store||''),itemOwner=tv2LotteryExactNormalize_(item.owner||'');
     const titleMatch=itemTitle===wantedTitle||itemTitle.includes(wantedTitle)||wantedTitle.includes(itemTitle);
     const storeMatch=itemStore===wantedStore||itemStore.includes(wantedStore)||wantedStore.includes(itemStore);
     const existingResultDate=String(item.resultDate||'').slice(0,10),dateMatch=!existingResultDate||existingResultDate===resultDate;
     const ownerMatch=!wantedOwner||!itemOwner||itemOwner===wantedOwner;
     const applicationMatch=!applicationDate||String(item.applicationDate||'').slice(0,10)===applicationDate;
     return titleMatch&&storeMatch&&dateMatch&&ownerMatch&&applicationMatch;
    });
    if(matches.length!==1)throw new Error(matches.length?'抽選patch exact対象が複数一致しました':'抽選patch exact対象が見つかりません');
    const item=matches[0],before=JSON.stringify(matches[0]);
    item.title=newTitle;
    if(!String(item.resultDate||'').slice(0,10))item.resultDate=resultDate;
    if(deadline)item.deadline=deadline;
    if(receiveDeadline)item.receiveDeadline=receiveDeadline;
    if(memo&&!String(item.memo||'').includes(memo))item.memo=[String(item.memo||'').trim(),memo].filter(Boolean).join('｜');
    item.updatedAt=new Date().toISOString();
    return{changed:JSON.stringify(item)!==before,lotteryId:String(item.id||''),status:item.status,resultDate:item.resultDate,title:item.title,store:item.store};
   });
   tv2DeleteDraft_(draft);
   const resultSubject='[Toreca Vault Lottery Patch] '+requestId,to=Session.getEffectiveUser().getEmail();
   tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===resultSubject).forEach(d=>tv2DeleteDraft_(d));
   if(to)tv2CreateDraft_(to,resultSubject,JSON.stringify({ok:true,requestId,result},null,2));
   results.push({ok:true,requestId,result});
  }catch(err){results.push({ok:false,error:String(err&&err.message||err)})}
 });
 return results;
}
function tv2ProcessExactLotteryResultDrafts_(){
 const subject='[Toreca Vault Command]',results=[];
 const drafts=tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject);
 drafts.forEach(draft=>{
  try{
   const raw=String(tv2DraftPlainBody_(draft)||'').trim();let command;try{command=JSON.parse(raw)}catch(e){return}
   if(String(command&&command.type||'')!=='lottery-result-exact')return;
   const requestId=String(command.requestId||'').trim(),title=String(command.title||command.product||'').trim(),store=String(command.store||'').trim(),owner=String(command.owner||'').trim(),status=String(command.status||'').trim(),resultDate=String(command.resultDate||'').trim(),memo=String(command.memo||'').trim();
   if(!requestId||!title||!store||!['当選','落選'].includes(status)||!/^\d{4}-\d{2}-\d{2}$/.test(resultDate))throw new Error('抽選結果exactコマンドが不正です');
   const wantedTitle=tv2LotteryExactNormalize_(title),wantedStore=tv2LotteryStoreNormalize_(store),wantedOwner=tv2LotteryExactNormalize_(owner);
   const result=tv2Mutate_('chat-lottery-result-exact',state=>{
    state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
    const matches=state.lotteries.filter(item=>{
     const itemTitle=tv2LotteryExactNormalize_(item.title||''),itemStore=tv2LotteryStoreNormalize_(item.store||''),itemOwner=tv2LotteryExactNormalize_(item.owner||'');
     const titleMatch=itemTitle===wantedTitle||itemTitle.includes(wantedTitle)||wantedTitle.includes(itemTitle);
     const storeMatch=itemStore===wantedStore||itemStore.includes(wantedStore)||wantedStore.includes(itemStore);
     const existingResultDate=String(item.resultDate||'').slice(0,10),dateMatch=!existingResultDate||existingResultDate===resultDate;
     const ownerMatch=!wantedOwner||!itemOwner||itemOwner===wantedOwner;
     return titleMatch&&storeMatch&&dateMatch&&ownerMatch;
    });
    if(matches.length!==1)throw new Error(matches.length?'抽選結果exact対象が複数一致しました':'抽選結果exact対象が見つかりません');
    const item=matches[0];
    if(status==='落選'&&(item.status==='購入済'||item.receiptStatus==='受取済み'))throw new Error('購入済み/受取済み抽選を落選へ変更できません');
    const before=JSON.stringify(item),now=new Date().toISOString();
    item.status=status;item.resultDate=resultDate;
    if(status==='落選'&&item.receiptStatus!=='受取済み')item.receiptStatus='対象外';
    if(status==='当選'&&!['未受取','受取済み'].includes(String(item.receiptStatus||'')))item.receiptStatus='未受取';
    if(memo&&!String(item.memo||'').includes(memo))item.memo=[String(item.memo||'').trim(),memo].filter(Boolean).join('｜');
    item.updatedAt=now;
    return{changed:JSON.stringify(item)!==before,lotteryId:String(item.id||''),status:item.status,resultDate:item.resultDate,title:item.title,store:item.store};
   });
   tv2DeleteDraft_(draft);
   const resultSubject='[Toreca Vault Lottery Result] '+requestId,to=Session.getEffectiveUser().getEmail();
   tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===resultSubject).forEach(d=>tv2DeleteDraft_(d));
   if(to)tv2CreateDraft_(to,resultSubject,JSON.stringify({ok:true,requestId,result},null,2));
   results.push({ok:true,requestId,result});
  }catch(err){results.push({ok:false,error:String(err&&err.message||err)})}
 });
 return results;
}
function tv2RepairEdionKashiharaAlias20261015_(){
 const canonicalStore='トレカ・キャピタル エディオンイオンモール橿原店',newId='lottery-edion-kashihara-20261015-9541242',resultDate='2026-10-15';
 const n=tv2LotteryExactNormalize_,sn=tv2LotteryStoreNormalize_,aliasKey=sn(canonicalStore);
 const isProduct=x=>{const t=n(x&&x.title||'');return t.includes(n('30th CELEBRATION'))&&(t.includes(n('カードセット'))||t.includes(n('9種')))};
 const ownerOk=x=>{const o=n(x&&x.owner||'');return !/嫁|妻/.test(String(x&&x.owner||''))&&!/嫁分|妻分|奥さん/.test(String(x&&x.memo||''))&&(!o||o===n('本人')||o===n('本人分'))};
 const dateOk=x=>{const d=String(x&&x.resultDate||'').slice(0,10);return !d||d===resultDate};
 // This is a one-time repair called from the 15-minute runner. Once its marker
 // and canonical record are verified, skip the mutation and Gmail result-draft
 // rewrite on every later run (which otherwise exhausts the daily Gmail quota).
 const existing=tv2Load_(),existingState=existing.payload||{},existingAutomation=existingState.automation||{};
 const existingMatches=(existingState.lotteries||[]).filter(x=>sn(x.store||'')===aliasKey&&isProduct(x)&&ownerOk(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
 const alreadyRepaired=String(existingAutomation.edionKashiharaStoreAlias||'')==='2026-10-15-v1'&&existingMatches.length===1&&String(existingMatches[0].id||'')===newId&&['当選','購入済'].includes(String(existingMatches[0].status||''))&&String(existingMatches[0].receiveDeadline||'').slice(0,10)==='2026-10-19';
 if(alreadyRepaired)return{ok:true,skipped:true,reason:'already-repaired',revision:Number(existing.revision),matches:existingMatches.map(x=>({id:x.id,store:x.store,status:x.status,resultDate:x.resultDate,receiveDeadline:x.receiveDeadline}))};
 const mutation=tv2Mutate_('edion-kashihara-store-alias-20261015',state=>{
  state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};
  const current=state.lotteries.filter(x=>String(x.id||'')===newId);
  if(current.length!==1)return{changed:false,review:true,reason:'10/15エディオン当選レコードを一意に確認できません',count:current.length};
  const created=current[0],others=state.lotteries.filter(x=>x!==created&&sn(x.store||'')===aliasKey&&isProduct(x)&&ownerOk(x)&&dateOk(x));
  if(others.length>1)return{changed:false,review:true,reason:'同一店舗aliasの既存候補が複数あるため自動統合停止',candidateIds:others.map(x=>String(x.id||''))};
  let keep=created,removedId='';
  if(others.length===1){
   keep=others[0];removedId=String(created.id||'');
   for(const k of ['applicationDate','deadline','gmailMessageId','createdAt'])if(!keep[k]&&created[k])keep[k]=created[k];
   const mem=[String(keep.memo||''),String(created.memo||'')].join('｜').split('｜').map(x=>x.trim()).filter(Boolean),seen=[];
   mem.forEach(x=>{if(!seen.includes(x))seen.push(x)});keep.memo=seen.join('｜');
   state.lotteries=state.lotteries.filter(x=>x!==created);
  }
  const before=JSON.stringify(keep);
  keep.title='ポケモンカードゲーム MEGA 30th CELEBRATION カードセット（9種）';
  keep.store=canonicalStore;keep.owner='本人';keep.resultDate=resultDate;keep.receiveDeadline='2026-10-19';
  if(keep.status==='購入済'||keep.receiptStatus==='受取済み'){keep.status='購入済';keep.receiptStatus='受取済み'}else{keep.status='当選';keep.receiptStatus='未受取'}
  const parts=['当選数量 2セット','照合ID 9541242'],memo=String(keep.memo||'').split('｜').map(x=>x.trim()).filter(Boolean);
  parts.forEach(x=>{if(!memo.includes(x))memo.push(x)});keep.memo=memo.join('｜');keep.updatedAt=new Date().toISOString();
  state.automation.edionKashiharaStoreAlias='2026-10-15-v1';
  return{changed:Boolean(removedId)||JSON.stringify(keep)!==before,review:false,keptId:String(keep.id||''),removedId,store:keep.store,status:keep.status,resultDate:keep.resultDate,receiveDeadline:keep.receiveDeadline};
 });
 const check=tv2Load_(),state=check.payload||{},matches=(state.lotteries||[]).filter(x=>tv2LotteryStoreNormalize_(x.store||'')===aliasKey&&isProduct(x)&&ownerOk(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
 const verified=!mutation.review&&matches.length===1&&['当選','購入済'].includes(String(matches[0].status||''))&&String(matches[0].receiveDeadline||'').slice(0,10)==='2026-10-19';
 if(verified&&typeof GmailApp!=='undefined'){
  const requestId='20261015-edion-kashihara-store-alias-repair',subject='[Toreca Vault Lottery Result] '+requestId,to=Session.getEffectiveUser().getEmail(),body=JSON.stringify({ok:true,requestId,revision:Number(check.revision),mutation,lottery:{id:matches[0].id,title:matches[0].title,store:matches[0].store,owner:matches[0].owner,status:matches[0].status,resultDate:matches[0].resultDate,receiveDeadline:matches[0].receiveDeadline,memo:matches[0].memo}},null,2);
  tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject).forEach(d=>tv2DeleteDraft_(d));
  if(to)tv2CreateDraft_(to,subject,body);
 }
 return{ok:verified,revision:Number(check.revision),mutation,matches:matches.map(x=>({id:x.id,store:x.store,status:x.status,resultDate:x.resultDate,receiveDeadline:x.receiveDeadline}))};
}

function tv2EnforceRetailPricePolicy_(){
 const edionAliasRepair=tv2RepairEdionKashiharaAlias20261015_();
 const edionConfirmed=tv2ProcessConfirmedEdionDrafts_();
 const lotteryPatches=tv2ProcessExactLotteryPatchDrafts_();
 const lotteryResults=tv2ProcessExactLotteryResultDrafts_();
 const packOpenings=tv2ProcessPackOpeningDrafts_();
 const result=tv2Mutate_('retail-price-policy',state=>{
  const health=tv2Health_(state),beforeVersion=String(health.retailPricePolicyVersion||''),beforeReview=JSON.stringify(health.retailPriceNeedsReview||[]),changes=[],review=new Set();
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  for(const t of state.transactions){
   if(String(t.category||'')==='カード')continue;const q=Math.max(1,Number(t.quantity)||1),info=tv2RetailPriceInfo_(t.productKey||t.product,t.category,q);if(!info){if(['purchase','sale','opening'].includes(String(t.type||'')))review.add(String(t.product||t.productKey||''));continue}
   if(t.type==='purchase'){
    const old=Number(t.price!==undefined?t.price:t.unitCost);if(Number.isFinite(old)&&old>=0&&old!==info.price&&t.actualPaid==null){t.actualPaid=old;t.actualPaidTotal=old*q}
    if(Number(t.price)!==info.price||Number(t.total)!==info.price*q||Number(t.unitCost)!==info.price)changes.push('purchase:'+String(t.id||t.product));
    t.price=info.price;t.total=info.price*q;t.unitCost=info.price;t.priceBasis='希望小売価格';t.retailPriceSource=info.source;
   }else if(t.type==='sale'||t.type==='opening'){
    const target=info.price*q;if(Number(t.acquisitionCost)!==target)changes.push(String(t.type)+':'+String(t.id||t.product));t.acquisitionCost=target;t.acquisitionCostBasis='希望小売価格';t.retailPriceSource=info.source;
   }
  }
  for(const l of state.inventoryLots){
   if(String(l.category||'')==='カード')continue;const q=Math.max(1,Number(l.quantity)||1),info=tv2RetailPriceInfo_(l.productKey||l.product,l.category,q);if(!info){review.add(String(l.product||l.productKey||''));continue}
   if(Number(l.unitCost)!==info.price)changes.push('lot:'+String(l.id||l.product));l.unitCost=info.price;l.priceBasis='希望小売価格';l.retailPriceSource=info.source;
  }
  for(const item of state.lotteries){
   const category=String(item.receiptCategory||'').trim();if(!category||category==='カード')continue;const q=Math.max(1,Number(item.receiptQuantity)||1),info=tv2RetailPriceInfo_(item.receiptProduct||item.title,category,q);if(!info)continue;
   const target=info.price*q,old=Number(item.receiptAmount);
   if(Number.isFinite(old)&&old>=0&&old!==target&&item.receiptPaidAmount==null)item.receiptPaidAmount=old;
   if(Number(item.receiptAmount)!==target)changes.push('receipt:'+String(item.id||item.title));item.receiptAmount=target;item.receiptPriceBasis='希望小売価格';item.retailPriceSource=info.source;
  }
  const reviews=[...review].filter(Boolean).sort();health.retailPricePolicyVersion=TV2_RETAIL_PRICE_POLICY_VERSION;health.retailPriceNeedsReview=reviews;
  const changed=changes.length>0||beforeVersion!==TV2_RETAIL_PRICE_POLICY_VERSION||beforeReview!==JSON.stringify(reviews);
  return{changed,changes,review:reviews,policy:TV2_RETAIL_PRICE_POLICY_VERSION};
 });
 if(result&&typeof result==='object'){result.edionAliasRepair=edionAliasRepair;result.edionConfirmed=edionConfirmed;result.lotteryPatches=lotteryPatches;result.lotteryResults=lotteryResults;result.packOpenings=packOpenings}
 if(result&&result.changed&&!result.unchanged){
  const subject='[Toreca Vault MSRP Policy Result] '+TV2_RETAIL_PRICE_POLICY_VERSION,to=Session.getEffectiveUser().getEmail();
  tv2GetDrafts_().filter(d=>String(tv2DraftSubject_(d)||'').trim()===subject).forEach(d=>tv2DeleteDraft_(d));
  if(to)tv2CreateDraft_(to,subject,JSON.stringify(result,null,2));
 }
 return result;
}
