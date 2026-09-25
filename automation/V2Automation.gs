const TV2_SYNC_URL_PROP='TV2_SYNC_URL';
const TV2_SYNC_TOKEN_PROP='TV2_SYNC_TOKEN';
const TV2_STORES=['買取ミミ','AMTAF','アリウム'];

function installTv2Automation(){
  // Only replace schedules after both V2 jobs have successfully read and
  // verified the canonical state. A failed connection must not install jobs.
  const lottery=runTv2LotteryAuto(),market=runTv2MarketAuto();
  if(lottery.skipped||market.skipped)throw new Error('V2自動化の実行がスキップされたためトリガーを作成しません');
  ScriptApp.getProjectTriggers().forEach(t=>{if(['runTv2LotteryAuto','runTv2MarketAuto'].includes(t.getHandlerFunction()))ScriptApp.deleteTrigger(t)});
  ScriptApp.newTrigger('runTv2LotteryAuto').timeBased().atHour(12).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTv2LotteryAuto').timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTv2MarketAuto').timeBased().atHour(15).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  PropertiesService.getScriptProperties().setProperty('TV2_MARKET_SCHEDULE_V2','15');
  return {lottery,market};
}
function runTv2LotteryAuto(){
  return tv2Mutate_('gmail-auto',state=>{
    const now=new Date(),health=tv2Health_(state),last=health.lastGmailRunAt?new Date(health.lastGmailRunAt):null;
    // Revisit recent mail because delivery and trigger execution can be delayed.
    // Message IDs make this overlap idempotent.
    const since=last&&!isNaN(last.getTime())?new Date(last.getTime()-2*86400000):new Date(now.getTime()-7*86400000);
    const processed=new Set(health.gmailMessageIds||[]),newIds=[],reviews=[];let changed=false;
    const report={updated:0,created:0,duplicate:0,outside:0,review:0,scanned:0,at:now.toISOString()};
    const query='after:'+Utilities.formatDate(since,TZ,'yyyy/MM/dd'),threads=[];
    for(let offset=0;offset<2000;offset+=100){
      const page=GmailApp.search(query,offset,100);
      threads.push(...page);
      if(page.length<100)break;
      if(offset===1900)throw new Error('Gmail検索が2000スレッドを超えました。対象期間を確認してください');
    }
    threads.forEach(th=>th.getMessages().forEach(message=>{
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
        else{
          const item=match.item,old=JSON.stringify(item);
          const conflict=(parsed.status==='落選'&&(['当選','購入済'].includes(item.status)||item.receiptStatus==='受取済み'))||
            (parsed.status==='当選'&&item.status==='落選');
          if(conflict){report.review++;reviews.push({messageId:id,reason:'既存の当落・購入・受取状態と結果メールが競合',subject:message.getSubject()})}
          else{
            if(['応募済','応募済み'].includes(item.status))item.status=parsed.status;
            item.resultDate=parsed.resultDate||item.resultDate;
            if(parsed.receiveDeadline)item.receiveDeadline=parsed.receiveDeadline;
            if(parsed.status==='当選'&&!['受取済み','未受取'].includes(item.receiptStatus))item.receiptStatus='未受取';
            if(parsed.status==='落選'&&item.receiptStatus!=='受取済み')item.receiptStatus='対象外';
            item.updatedAt=now.toISOString();
            if(JSON.stringify(item)!==old){report.updated++;changed=true}else report.duplicate++;
          }
        }
      }newIds.push(id);
    }));
    health.gmailMessageIds=[...processed,...newIds].slice(-3000);health.lastGmailRunAt=now.toISOString();health.gmailReview=report.review;health.gmailStatus=report.review?'review':'ok';health.gmailNeedsReview=[...(health.gmailNeedsReview||[]),...reviews].slice(-200);
    return {changed:true,report};
  });
}
function runTv2MarketAuto(){
 const outcome=tv2Mutate_('market-auto',state=>{const now=new Date(),health=tv2Health_(state),reviews=[];const report={updated:0,unchanged:0,review:0,at:now.toISOString()};
  const cards=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&l.category==='カード');
  let rows=null;
  if(cards.length){try{rows=fetchCardrushRows_()}catch(err){reviews.push('カードラッシュCSV取得失敗: '+String(err))}}
  const date=Utilities.formatDate(now,TZ,'yyyy-MM-dd'),seen=new Set();
  cards.forEach(lot=>{
    const key=normalize_(lot.productKey||lot.product)+'|'+String(lot.condition||'');
    if(seen.has(key))return;seen.add(key);
    const model=extractModel_([lot.set,lot.product].filter(Boolean).join(' '));
    // The public buyback list describes standard condition. Other card conditions
    // cannot be priced from it without guessing a discount.
    if(!rows||!model||!['良品',''].includes(String(lot.condition||''))){
      report.review++;reviews.push(lot.product+': 型番・状態・価格ソースを確認できず前回価格維持');return;
    }
    const name=String(lot.product||'').replace(model,'').trim();
    const result=name?findCardrushBuyback_(rows,name,model):null;
    if(!result||!Number.isFinite(result.price)||result.price<=0){
      report.review++;reviews.push(lot.product+': 完全一致の買取価格なし・前回価格維持');return;
    }
    const quote=tv2FindQuote_(state,lot);
    if(quote&&String(quote.checkedAt||'')>date){report.unchanged++;return}
    const old=quote?Number(quote.price):result.price;
    const target=quote||{lotId:lot.id,product:lot.product,productKey:lot.productKey,category:lot.category,condition:lot.condition};
    target.previousPrice=Number.isFinite(old)?old:result.price;
    target.price=result.price;target.checkedAt=date;target.source='カードラッシュ';target.fresh=true;
    target.trend=result.price>target.previousPrice?'up':result.price<target.previousPrice?'down':'same';
    target.history=Array.isArray(target.history)?target.history:[];
    if(!target.history.some(h=>String(h.checkedAt||h.date)===date&&Number(h.price??h.value)===result.price))
      target.history.push({date,value:result.price,source:target.source});
    target.history=target.history.slice(-400);
    if(!quote)state.marketQuotes.push(target);
    if(quote&&old===result.price)report.unchanged++;else report.updated++;
  });
  let feed={products:[],error:''};
  const sealed=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&['BOX','パック'].includes(l.category));
  if(sealed.length){try{
    const response=UrlFetchApp.fetch('https://torekakaku-navi.com/',{muteHttpExceptions:true,followRedirects:true});
    if(response.getResponseCode()!==200)throw new Error('HTTP '+response.getResponseCode());
    feed=tv2ParseSealedFeed_(response.getContentText('UTF-8'),date);
  }catch(err){feed={products:[],error:'BOX相場取得失敗: '+String(err)}}}
  if(feed.error)reviews.push(feed.error);
  const sealedSeen=new Set();
  sealed.forEach(lot=>{
    const key=normalize_(lot.productKey||lot.product)+'|'+lot.category+'|'+String(lot.condition||'');
    if(sealedSeen.has(key))return;sealedSeen.add(key);
    const condition=tv2SealedCondition_(lot);
    const name=tv2SealedName_(lot.product||lot.productKey);
    const matches=condition&&name?feed.products.filter(p=>[p.name,p.official].some(s=>tv2SealedName_(s)===name)):[];
    const offers=matches.length===1?(matches[0].offers[condition]||[]):[];
    const best=offers.sort((a,b)=>b.price-a.price)[0];
    if(!best){const q=tv2FindQuote_(state,lot);if(q){q.fresh=false;q.trend='stale'}
      report.review++;reviews.push(lot.product+': 同一商品・同一状態の当日X出典を確認できず前回価格維持');return}
    const quote=tv2FindQuote_(state,lot);
    if(quote&&String(quote.checkedAt||'')>date){report.unchanged++;return}
    const previous=quote?Number(quote.price):best.price;
    if(Number.isFinite(previous)&&previous>0&&(best.price>previous*1.5||best.price<previous*0.5)){
      if(quote){quote.fresh=false;quote.trend='stale'}
      report.review++;reviews.push(lot.product+': 前回価格から50%超の変動・X画像と公式商品情報の再確認が必要');return;
    }
    const target=quote||{lotId:lot.id,product:lot.product,productKey:lot.productKey,category:lot.category,condition:lot.condition};
    target.previousPrice=Number.isFinite(previous)?previous:best.price;
    target.price=best.price;target.checkedAt=date;
    target.source=best.shop+' '+date+' '+best.url+' ('+condition+')';target.fresh=true;
    target.trend=best.price>target.previousPrice?'up':best.price<target.previousPrice?'down':'same';
    target.history=Array.isArray(target.history)?target.history:[];
    if(!target.history.some(h=>String(h.checkedAt||h.date)===date&&Number(h.price??h.value)===best.price))
      target.history.push({date,value:best.price,source:target.source});
    target.history=target.history.slice(-400);
    if(!quote)state.marketQuotes.push(target);
    if(quote&&previous===best.price)report.unchanged++;else report.updated++;
  });
  health.lastMarketRunAt=now.toISOString();health.marketReview=report.review;health.marketStatus=report.review?'review':'ok';health.marketNeedsReview=reviews.slice(-200);return{changed:true,report};
 });
 tv2EnsureMarketSchedule_();
 return outcome;
}
function tv2SealedName_(s){return normalize_(String(s||'').replace(/&amp;/g,'&')).replace(/^ポケモンカードゲームmega/,'').replace(/^ポケモンカードゲーム/,'').replace(/^(?:強化拡張|拡張|ハイクラス)パック/,'').replace(/(?:未開封)?(?:box|ボックス)$/,'')}
function tv2SealedCondition_(lot){const c=normalize_(lot.condition);if(lot.category==='BOX')return c==='あり'||c==='シュリンクあり'||c==='シュリンク有'?'shrink':c==='なし'||c==='シュリンクなし'||c==='シュリンク無'?'no_shrink':'';if(lot.category==='パック')return c===''||c==='未開封'||c==='バラパック'?'loose_pack':'';return''}
function tv2ParseSealedFeed_(html,date){
  const text=String(html||'');
  if(!new RegExp('掲載日\\s*<b>'+date+'<\\/b>\\s*\\/\\s*スナップショット\\s*'+date).test(text))return{products:[],error:'BOX相場の掲載日・スナップショットが当日ではありません'};
  const starts=[...text.matchAll(/<div class="card(?:\s[^"]*)?"[^>]*>/g)],products=[];
  const stores={cardshop_allium:'アリウム',amtaf_shop:'AMTAF',mimi_kaitori:'買取ミミ'};
  for(let i=0;i<starts.length;i++){
    const head=starts[i][0];if(!/data-cat="box"/.test(head))continue;
    const block=text.slice(starts[i].index,starts[i+1]?.index||text.length),name=(head.match(/data-name="([^"]+)"/)||[])[1]||'';
    const official=(block.match(/<span class="official">([^<]+)<\/span>/)||[])[1]||'';
    if(!name||!official)continue;
    const rows=[...block.matchAll(/<div class="crow\b[^>]*data-cond="(shrink|no_shrink|loose_pack)"[^>]*>/g)],offers={};
    for(let j=0;j<rows.length;j++){
      const condition=rows[j][1],section=block.slice(rows[j].index,rows[j+1]?.index||block.length);
      offers[condition]=[];
      for(const match of section.matchAll(/<div class="cell\b[^>]*>[\s\S]*?<\/div>/g)){
        const cell=match[0],handle=(cell.match(/class="shop-link" href="https:\/\/x\.com\/([^"/]+)"/)||[])[1]?.toLowerCase();
        const source=(cell.match(/class="src" href="(https:\/\/x\.com\/([^"/]+)\/status\/\d+)"/)||[]);
        const price=Number(((cell.match(/class="price yen">¥([\d,]+)</)||[])[1]||'').replace(/,/g,''));
        if(handle&&stores[handle]&&source[2]?.toLowerCase()===handle&&Number.isFinite(price)&&price>0)
          offers[condition].push({shop:stores[handle],price,url:source[1]});
      }
    }
    products.push({name,official,offers});
  }
  return{products,error:''};
}
function tv2EnsureMarketSchedule_(){
  if(typeof ScriptApp==='undefined'||typeof PropertiesService==='undefined')return;
  const props=PropertiesService.getScriptProperties();
  if(props.getProperty('TV2_MARKET_SCHEDULE_V2')==='15')return;
  const old=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='runTv2MarketAuto');
  ScriptApp.newTrigger('runTv2MarketAuto').timeBased().atHour(15).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  old.forEach(t=>ScriptApp.deleteTrigger(t));
  props.setProperty('TV2_MARKET_SCHEDULE_V2','15');
}
function tv2PreviousDate_(date){const d=new Date(String(date)+'T12:00:00+09:00');d.setDate(d.getDate()-1);return Utilities.formatDate(d,TZ,'yyyy-MM-dd')}
function tv2FindQuote_(state,lot){return(state.marketQuotes||[]).find(q=>String(q.lotId||'')===String(lot.id||'')&&String(q.condition||'')===String(lot.condition||''))||(state.marketQuotes||[]).find(q=>normalize_(q.productKey||q.product)===normalize_(lot.productKey||lot.product)&&String(q.condition||'')===String(lot.condition||''))}
function tv2Health_(state){state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};state.automation.health=state.automation.health&&typeof state.automation.health==='object'?state.automation.health:{};return state.automation.health}
function tv2Config_(){const p=PropertiesService.getScriptProperties(),url=String(p.getProperty(TV2_SYNC_URL_PROP)||''),token=String(p.getProperty('TV_V2_SYNC_TOKEN')||''),alternate=String(p.getProperty(TV2_SYNC_TOKEN_PROP)||'');if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url))throw new Error('TV2_SYNC_URL が未設定です');const tokens=[...new Set([token,alternate].filter(t=>t.length>=24))];if(!tokens.length)throw new Error('V2同期トークンが未設定です');return{url,tokens}}
function tv2ParseResponse_(raw){const text=String(raw||'').trim();if(!text)throw new Error('V2 API empty response');let json=text;const m=text.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*([\s\S]*)\s*\)\s*;?$/);if(m)json=m[1].trim();try{return JSON.parse(json)}catch(e){throw new Error('V2 API response is not JSON/JSONP')}}
function tv2Call_(body){const c=tv2Config_();for(const token of c.tokens){const r=UrlFetchApp.fetch(c.url,{method:'post',contentType:'text/plain;charset=utf-8',payload:JSON.stringify(Object.assign({token},body)),muteHttpExceptions:true});const j=tv2ParseResponse_(r.getContentText());if(j.ok)return j;if(/unauthorized|認証に失敗/i.test(String(j.error||'')))continue;throw new Error(j.error||'V2 API error')}throw new Error('V2 API 認証に失敗しました。同期URLとスクリプトプロパティを確認してください')}
function tv2Load_(){const j=tv2Call_({action:'load'});if(!j.payload||Number(j.payload.schemaVersion)!==2)throw new Error('V2正本ではありません');return j}
function tv2Mutate_(kind,fn){const lock=LockService.getScriptLock();if(!lock.tryLock(30000))return{skipped:true,reason:'locked'};try{const before=tv2Load_(),next=JSON.parse(JSON.stringify(before.payload)),result=fn(next)||{};next.revision=Number(before.revision)+1;next.lastMutationId=kind+'-'+Utilities.getUuid();next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];next.auditLog.push({mutationId:next.lastMutationId,revision:next.revision,type:kind,at:new Date().toISOString()});tv2Call_({expectedRevision:before.revision,mutationId:next.lastMutationId,payload:next});const check=tv2Load_();if(Number(check.revision)!==next.revision||check.lastMutationId!==next.lastMutationId)throw new Error('V2保存後検証失敗');return Object.assign({revision:check.revision},result)}finally{lock.releaseLock()}}
