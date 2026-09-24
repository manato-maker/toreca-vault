const TV2_SYNC_URL_PROP='TV2_SYNC_URL';
const TV2_SYNC_TOKEN_PROP='TV2_SYNC_TOKEN';
const TV2_SEALED_FEED='https://torekakaku-navi.com/';
const TV2_STORES=['買取ミミ','AMTAF','アリウム'];

function installTv2Automation(){
  tv2Config_();
  ScriptApp.getProjectTriggers().forEach(t=>{if(['runTv2LotteryAuto','runTv2MarketAuto'].includes(t.getHandlerFunction()))ScriptApp.deleteTrigger(t)});
  ScriptApp.newTrigger('runTv2LotteryAuto').timeBased().atHour(12).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTv2LotteryAuto').timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTv2MarketAuto').timeBased().atHour(13).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  return {lottery:runTv2LotteryAuto(),market:runTv2MarketAuto()};
}
function runTv2LotteryAuto(){
  return tv2Mutate_('gmail-auto',state=>{
    const now=new Date(),health=tv2Health_(state),since=health.lastGmailRunAt?new Date(health.lastGmailRunAt):new Date(now.getTime()-3*86400000);
    const processed=new Set(health.gmailMessageIds||[]),newIds=[],reviews=[];let changed=false;
    const report={updated:0,created:0,duplicate:0,outside:0,review:0,scanned:0,at:now.toISOString()};
    GmailApp.search('newer_than:4d',0,200).forEach(th=>th.getMessages().forEach(message=>{
      if(message.getDate()<=since)return;const id=message.getId();if(processed.has(id))return;
      const text=[message.getSubject(),message.getPlainBody()].join('\n');
      if(!CARD_WORDS.test(text)||(!RESULT_WORDS.test(text)&&!APPLICATION_WORDS.test(text)))return;report.scanned++;
      if(APPLICATION_WORDS.test(text)&&!RESULT_WORDS.test(text)){
        const before=state.lotteries.length,r=upsertApplication_(state.lotteries,text,message,now);
        if(r.kind==='created'){report.created++;changed=true}else if(r.kind==='duplicate')report.duplicate++;else{report.review++;reviews.push({messageId:id,reason:r.reason,subject:message.getSubject()})}
        newIds.push(id);return;
      }
      const match=matchLottery_(state.lotteries,text);
      if(match.kind==='outside')report.outside++;else if(match.kind==='review'){report.review++;reviews.push({messageId:id,reason:match.reason,subject:message.getSubject()})}else{
        const parsed=parseResult_(text,message.getDate());if(!parsed.status){report.review++;reviews.push({messageId:id,reason:'当落を一意に判別できない',subject:message.getSubject()})}
        else{const item=match.item,old=JSON.stringify(item);if(item.receiptStatus==='受取済み'&&parsed.status==='落選'){report.review++;reviews.push({messageId:id,reason:'受取済みと落選メールが競合',subject:message.getSubject()})}
        else{if(item.status==='応募済'||(item.status==='当選'&&parsed.status==='当選'))item.status=parsed.status;item.resultDate=parsed.resultDate||item.resultDate;if(parsed.receiveDeadline)item.receiveDeadline=parsed.receiveDeadline;if(parsed.status==='当選'&&!['受取済み','未受取'].includes(item.receiptStatus))item.receiptStatus='未受取';if(parsed.status==='落選'&&item.receiptStatus!=='受取済み')item.receiptStatus='対象外';item.updatedAt=now.toISOString();if(JSON.stringify(item)!==old){report.updated++;changed=true}else report.duplicate++;}}
      }newIds.push(id);
    }));
    health.gmailMessageIds=[...processed,...newIds].slice(-3000);health.lastGmailRunAt=now.toISOString();health.gmailReview=report.review;health.gmailStatus=report.review?'review':'ok';health.gmailNeedsReview=[...(health.gmailNeedsReview||[]),...reviews].slice(-200);
    return {changed:true,report};
  });
}
function runTv2MarketAuto(){
 return tv2Mutate_('market-auto',state=>{const now=new Date(),date=Utilities.formatDate(now,TZ,'yyyy-MM-dd'),health=tv2Health_(state),reviews=[];let changed=false;const report={updated:0,unchanged:0,review:0,at:now.toISOString()};
  let html='';try{const r=UrlFetchApp.fetch(TV2_SEALED_FEED,{muteHttpExceptions:true,followRedirects:true});if(r.getResponseCode()===200)html=r.getContentText('UTF-8')}catch(e){reviews.push('相場フィード取得失敗')}
  const page=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ');
  (state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&['BOX','パック'].includes(l.category)).forEach(lot=>{
    const q=tv2FindQuote_(state,lot),old=q?Number(q.price):null,candidates=[];if(html&&html.includes(date)){const p=normalize_(page).indexOf(normalize_(lot.product));if(p>=0){const around=page.slice(Math.max(0,p-500),p+2500);TV2_STORES.forEach(store=>{const m=around.match(new RegExp(store+'[^¥￥0-9]{0,120}[¥￥]?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})'));if(m)candidates.push({store,price:Number(m[1].replace(/,/g,''))})})}}
    if(!candidates.length){if(q){q.fresh=false;q.trend='stale'}report.review++;reviews.push(lot.product+': 3店の当日完全一致なし');return}
    const best=candidates.reduce((a,b)=>b.price>a.price?b:a),next=q||{lotId:lot.id,product:lot.product,condition:lot.condition,history:[]};next.previousPrice=old==null?best.price:old;next.price=best.price;next.checkedAt=date;next.source=best.store+' '+date;next.fresh=true;next.trend=old==null?'same':best.price>old?'up':best.price<old?'down':'same';next.history=Array.isArray(next.history)?next.history:[];if(!next.history.some(h=>h.date===date&&Number(h.value)===best.price))next.history.push({date,value:best.price,source:next.source});next.history=next.history.slice(-400);if(!q)state.marketQuotes.push(next);if(old===best.price)report.unchanged++;else{report.updated++;changed=true}
  });
  health.lastMarketRunAt=now.toISOString();health.marketReview=report.review;health.marketStatus=report.review?'review':'ok';health.marketNeedsReview=reviews.slice(-200);return{changed:true,report};
 });
}
function tv2FindQuote_(state,lot){return(state.marketQuotes||[]).find(q=>String(q.lotId||'')===String(lot.id||''))||(state.marketQuotes||[]).find(q=>normalize_(q.productKey||q.product)===normalize_(lot.productKey||lot.product)&&String(q.condition||'')===String(lot.condition||''))}
function tv2Health_(state){state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};state.automation.health=state.automation.health&&typeof state.automation.health==='object'?state.automation.health:{};return state.automation.health}
function tv2Config_(){const p=PropertiesService.getScriptProperties(),url=String(p.getProperty(TV2_SYNC_URL_PROP)||''),token=String(p.getProperty(TV2_SYNC_TOKEN_PROP)||p.getProperty('TV_V2_SYNC_TOKEN')||'');if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url))throw new Error('TV2_SYNC_URL が未設定です');if(token.length<24)throw new Error('TV2_SYNC_TOKEN が未設定です');return{url,token}}
function tv2ParseResponse_(raw){const text=String(raw||'').trim();if(!text)throw new Error('V2 API empty response');let json=text;const m=text.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*([\s\S]*)\s*\)\s*;?$/);if(m)json=m[1].trim();try{return JSON.parse(json)}catch(e){throw new Error('V2 API response is not JSON/JSONP')}}
function tv2Call_(body){const c=tv2Config_(),r=UrlFetchApp.fetch(c.url,{method:'post',contentType:'text/plain;charset=utf-8',payload:JSON.stringify(Object.assign({token:c.token},body)),muteHttpExceptions:true});const j=tv2ParseResponse_(r.getContentText());if(!j.ok)throw new Error(j.error||'V2 API error');return j}
function tv2Load_(){const j=tv2Call_({action:'load'});if(!j.payload||Number(j.payload.schemaVersion)!==2)throw new Error('V2正本ではありません');return j}
function tv2Mutate_(kind,fn){const lock=LockService.getScriptLock();if(!lock.tryLock(30000))return{skipped:true,reason:'locked'};try{const before=tv2Load_(),next=JSON.parse(JSON.stringify(before.payload)),result=fn(next)||{};next.revision=Number(before.revision)+1;next.lastMutationId=kind+'-'+Utilities.getUuid();next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];next.auditLog.push({mutationId:next.lastMutationId,revision:next.revision,type:kind,at:new Date().toISOString()});tv2Call_({expectedRevision:before.revision,mutationId:next.lastMutationId,payload:next});const check=tv2Load_();if(Number(check.revision)!==next.revision||check.lastMutationId!==next.lastMutationId)throw new Error('V2保存後検証失敗');return Object.assign({revision:check.revision},result)}finally{lock.releaseLock()}}
