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
  tv2EnsurePickupSchedule_();
  return {lottery,market};
}
function runTv2LotteryAuto(){
  if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
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
 if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
 const outcome=tv2Mutate_('market-auto',state=>{const now=new Date(),health=tv2Health_(state),reviews=[];const report={updated:0,unchanged:0,review:0,at:now.toISOString()};
  const cards=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&l.category==='カード');
  let rows=null;
  if(cards.length){try{rows=fetchCardrushRows_()}catch(err){reviews.push('カードラッシュCSV取得失敗: '+String(err))}}
  const date=Utilities.formatDate(now,TZ,'yyyy-MM-dd'),seen=new Set();
  cards.forEach(lot=>{
    const key=String(lot.id||normalize_(lot.productKey||lot.product)+'|'+String(lot.condition||''));
    if(seen.has(key))return;seen.add(key);
    if(lot.identityNeedsReview===true){report.review++;reviews.push(lot.product+': カード番号は買取価格からの推定・現物確認まで前回価格維持');return}
    const model=extractModel_([lot.set,lot.product].filter(Boolean).join(' '));
    // The public buyback list describes standard condition. Other card conditions
    // cannot be priced from it without guessing a discount.
    if(!rows||!model||!['良品',''].includes(String(lot.condition||''))){
      report.review++;reviews.push(lot.product+': 型番・状態・価格ソースを確認できず前回価格維持');return;
    }
    const name=String(lot.product||'').replace(model,'').trim();
    const result=name?findCardrushBuyback_(rows,name,model,lot.variant):null;
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
  const pickup=tv2FetchPickupPosts_(sealed,health);
  if(pickup.errors.length){reviews.push(...pickup.errors);report.review+=pickup.errors.length}
  health.xPickupStatus=pickup.status;
  const sealedSeen=new Set();
  sealed.forEach(lot=>{
    const key=normalize_(lot.productKey||lot.product)+'|'+lot.category+'|'+String(lot.condition||'');
    if(sealedSeen.has(key))return;sealedSeen.add(key);
    const condition=tv2SealedCondition_(lot);
    const name=tv2SealedName_(lot.product||lot.productKey);
    const matches=condition&&name?feed.products.filter(p=>[p.name,p.official].some(s=>tv2SealedName_(s)===name)):[];
    const offers=matches.length===1?(matches[0].offers[condition]||[]):[];
    const pickupOffers=condition&&name?pickup.offers.filter(o=>o.category===lot.category&&o.condition===condition&&o.name===name):[];
    const quote=tv2FindQuote_(state,lot);
    const saved=condition&&quote&&quote.category===lot.category&&quote.shopOffers&&typeof quote.shopOffers==='object'?quote.shopOffers:{};
    const latest=Object.assign({},saved);
    offers.filter(offer=>!pickup.uncertainShops.includes(offer.shop)).forEach(offer=>{const next={shop:offer.shop,price:offer.price,url:offer.url,date:feed.date,postId:tv2PostId_(offer.url)};if(tv2OfferNewer_(next,latest[offer.shop]))latest[offer.shop]=next});
    pickupOffers.sort((a,b)=>tv2ComparePostId_(a.postId,b.postId)).forEach(offer=>{if(tv2OfferNewer_(offer,latest[offer.shop]))latest[offer.shop]=offer});
    const best=condition&&Object.values(latest).filter(o=>o&&Number.isFinite(Number(o.price))&&Number(o.price)>0&&/^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(String(o.url||''))).sort((a,b)=>b.price-a.price)[0];
    if(!best){const q=tv2FindQuote_(state,lot);if(q){q.fresh=false;q.trend='stale'}
      report.review++;reviews.push(lot.product+': 同一商品・同一状態の店舗別X出典を確認できず前回価格維持');return}
    if(quote&&String(quote.checkedAt||'')>date){report.unchanged++;return}
    const previous=quote?Number(quote.price):best.price;
    if(Number.isFinite(previous)&&previous>0&&(best.price>previous*1.5||best.price<previous*0.5)){
      if(quote){quote.fresh=false;quote.trend='stale'}
      report.review++;reviews.push(lot.product+': 前回価格から50%超の変動・X画像と公式商品情報の再確認が必要');return;
    }
    const target=quote||{lotId:lot.id,product:lot.product,productKey:lot.productKey,category:lot.category,condition:lot.condition};
    target.previousPrice=Number.isFinite(previous)?previous:best.price;
    target.price=best.price;target.checkedAt=date;target.shopOffers=latest;
    target.source=best.shop+' '+best.date+' '+best.url+' ('+condition+')';target.fresh=best.date===date&&!pickup.uncertainShops.includes(best.shop);
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
 tv2EnsurePickupSchedule_();
 return outcome;
}
function tv2SealedName_(s){return normalize_(String(s||'').replace(/&amp;/g,'&')).replace(/^ポケモンカードゲームmega/,'').replace(/^ポケモンカードゲーム/,'').replace(/^(?:強化拡張|拡張|ハイクラス)パック/,'').replace(/(?:未開封)?(?:box|ボックス)$/,'')}
function tv2IsPremiumDeck_(name){return tv2SealedName_(name)==='30thcelebrationプレミアムデッキセットエーフィブラッキー'}
function tv2SealedCondition_(lot){const c=normalize_(lot.condition);if(lot.category==='BOX'&&tv2IsPremiumDeck_(lot.product||lot.productKey))return c==='なし'||c==='シュリンクなし'?'': 'shrink';if(lot.category==='BOX')return c==='あり'||c==='シュリンクあり'||c==='シュリンク有'?'shrink':c==='なし'||c==='シュリンクなし'||c==='シュリンク無'?'no_shrink':'';if(lot.category==='パック')return c===''||c==='未開封'||c==='バラパック'?'loose_pack':'';return''}
function tv2ParseSealedFeed_(html,date){
  const text=String(html||'');
  const stamp=text.match(/掲載日\s*<b>(\d{4}-\d{2}-\d{2})<\/b>\s*\/\s*スナップショット\s*(\d{4}-\d{2}-\d{2})/);
  if(!stamp||stamp[1]!==stamp[2]||stamp[1]>date)return{products:[],error:'BOX相場の掲載日・スナップショットを確認できません'};
  const starts=[...text.matchAll(/<div class="card(?:\s[^"]*)?"[^>]*>/g)],products=[];
  const stores={cardshop_allium:'アリウム',amtaf_shop:'AMTAF',mimi_kaitori:'買取ミミ'};
  for(let i=0;i<starts.length;i++){
    const head=starts[i][0];if(!/data-cat="box"/.test(head)&&!(/data-cat="sealed_other"/.test(head)&&tv2IsPremiumDeck_((head.match(/data-name="([^"]+)"/)||[])[1])))continue;
    const block=text.slice(starts[i].index,starts[i+1]?.index||text.length),name=(head.match(/data-name="([^"]+)"/)||[])[1]||'';
    const official=(block.match(/<span class="official">([^<]+)<\/span>/)||[])[1]||'';
    if(!name||(!official&&!tv2IsPremiumDeck_(name)))continue;
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
    products.push({name,official:official||name,offers});
  }
  return{products,error:'',date:stamp[1]};
}
function tv2PostId_(url){return(String(url||'').match(/\/status\/(\d+)/)||[])[1]||''}
function tv2ComparePostId_(a,b){const x=String(a||''),y=String(b||'');return x.length-y.length||x.localeCompare(y)}
function tv2OfferNewer_(incoming,prior){if(!incoming||!incoming.date)return false;if(!prior)return true;
 const a=incoming.postId||tv2PostId_(incoming.url),b=prior.postId||tv2PostId_(prior.url);
 if(a&&b)return tv2ComparePostId_(a,b)>0;
 return String(incoming.date)>String(prior.date);
}
// X API credentials stay in Script Properties. Missing credentials preserve the daily comparison feed.
function tv2XGet_(path,token){const response=UrlFetchApp.fetch('https://api.x.com/2/'+path,{headers:{Authorization:'Bearer '+token},muteHttpExceptions:true});
 if(response.getResponseCode()!==200)throw new Error('X API HTTP '+response.getResponseCode());
 const result=JSON.parse(response.getContentText('UTF-8'));if(result.errors&&result.errors.length)throw new Error('X API returned errors');return result}
function tv2VisionText_(url,key){if(!/^https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_\-.?=&%]+$/.test(url))throw new Error('X画像URLが不正');
 const image=UrlFetchApp.fetch(url,{muteHttpExceptions:true});if(image.getResponseCode()!==200)throw new Error('X画像 HTTP '+image.getResponseCode());
 const body={requests:[{image:{content:Utilities.base64Encode(image.getBlob().getBytes())},features:[{type:'DOCUMENT_TEXT_DETECTION'}],imageContext:{languageHints:['ja']}}]};
 const r=UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate?key='+encodeURIComponent(key),{method:'post',contentType:'application/json',payload:JSON.stringify(body),muteHttpExceptions:true});
 if(r.getResponseCode()!==200)throw new Error('Vision OCR HTTP '+r.getResponseCode());const result=JSON.parse(r.getContentText('UTF-8')).responses?.[0]||{};
 if(result.error)throw new Error('Vision OCR 解析失敗');return String(result.fullTextAnnotation?.text||result.textAnnotations?.[0]?.description||'')}
function tv2PickupLineOffer_(line,lot){const name=tv2SealedName_(lot.product||lot.productKey),condition=tv2SealedCondition_(lot);
 if(!name||!condition||!line||line.length>140||!tv2SealedName_(line).includes(name))return null;
 const normalized=normalize_(line),shrink=/(?:シュリンク|シュリ)(?:あり|有)/.test(normalized),noShrink=/(?:シュリンク|シュリ)(?:なし|無)/.test(normalized);
 if(condition==='shrink'&&(!shrink||noShrink)||condition==='no_shrink'&&(!noShrink||shrink)||condition==='loose_pack'&&!/(?:バラパック|バラ売り|単品パック)/.test(normalized))return null;
 const prices=[...String(line).matchAll(/(?:[¥￥]\s*([\d,]{3,})|((?:\d{1,3}(?:,\d{3})+|\d{4,}|\d{3}\s*円))\s*円?)/g)].map(m=>Number((m[1]||m[2]).replace(/[,円\s]/g,''))).filter(n=>Number.isFinite(n)&&n>0);
 if(prices.length!==1)return null;return{category:lot.category,name,condition,price:prices[0]}}
function tv2PickupOffersFromText_(text,lots){const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean),out=[];
 for(let i=0;i<lines.length;i++){
  const next=/^[¥￥]?\s*[\d,]{3,}\s*円?$/.test(lines[i+1]||'')?lines[i]+' '+lines[i+1]:lines[i];
  const names=[...new Set(lots.map(lot=>tv2SealedName_(lot.product||lot.productKey)).filter(name=>name&&tv2SealedName_(next).includes(name)))];
  if(names.length>1&&/[¥￥]|\d{1,3},\d{3}|\d{3,}\s*円/.test(next))throw new Error('画像の同一行に複数商品があり価格を確定できません');
  for(const lot of lots){const offer=tv2PickupLineOffer_(next,lot);if(offer&&!out.some(x=>x.category===offer.category&&x.name===offer.name&&x.condition===offer.condition&&x.price===offer.price))out.push(offer)}
 }return out}
function tv2FetchPickupPosts_(lots,health){if(typeof PropertiesService==='undefined')return{offers:[],errors:[],uncertainShops:[],status:'unconfigured'};
 const p=PropertiesService.getScriptProperties(),token=String(p.getProperty('TV2_X_BEARER_TOKEN')||''),vision=String(p.getProperty('TV2_VISION_API_KEY')||'');
 if(!lots.length)return{offers:[],errors:[],uncertainShops:[],status:'no-inventory'};
 if(!token)return{offers:[],errors:['X追加投稿は未接続: TV2_X_BEARER_TOKEN が未設定'],uncertainShops:[],status:'unconfigured'};
 const shops=[['cardshop_allium','アリウム'],['AMTAF_SHOP','AMTAF'],['mimi_kaitori','買取ミミ']],offers=[],errors=[],uncertainShops=[];
 const ids=health.xUserIds&&typeof health.xUserIds==='object'?health.xUserIds:{},seen=health.xLastSeen&&typeof health.xLastSeen==='object'?health.xLastSeen:{};
 for(const [handle,shop] of shops){try{
  if(!ids[handle]){const user=tv2XGet_('users/by/username/'+encodeURIComponent(handle),token).data;if(!user||String(user.username).toLowerCase()!==handle.toLowerCase()||!/^\d+$/.test(user.id))throw new Error('店舗アカウントの照合に失敗');ids[handle]=user.id}
  const base='users/'+ids[handle]+'/tweets?max_results=10&post.fields=created_at,attachments&expansions=attachments.media_keys&media.fields=url,type';
  const media={},all=[];let cursor='',more=false;
  for(let page=0;page<5;page++){
   const path=base+(seen[handle]?'&since_id='+seen[handle]:'&start_time='+encodeURIComponent(new Date(Date.now()-2*86400000).toISOString()))+(cursor?'&pagination_token='+encodeURIComponent(cursor):'');
   const result=tv2XGet_(path,token);all.push(...(result.data||[]));(result.includes?.media||[]).forEach(m=>{media[m.media_key]=m});
   cursor=result.meta?.next_token||'';more=Boolean(cursor);if(!more)break;
  }
  if(more)throw new Error('未読投稿が50件を超えたため更新を保留');
  const posts=all.filter(post=>/^\d+$/.test(post.id)&&tv2ComparePostId_(post.id,seen[handle])>0).sort((a,b)=>tv2ComparePostId_(a.id,b.id));
  let failed=false;
  for(const post of posts){const instant=new Date(post.created_at),date=isNaN(instant.getTime())?'':Utilities.formatDate(instant,TZ,'yyyy-MM-dd');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){failed=true;break}
   if(!/買取|金額に変更/.test(String(post.text||''))){seen[handle]=post.id;continue}
   let extracted=tv2PickupOffersFromText_(post.text,lots),hadPhoto=false;
   for(const key of post.attachments?.media_keys||[]){const photo=media[key];if(photo?.type!=='photo'||!photo.url)continue;
    hadPhoto=true;
    if(!vision){errors.push(shop+' '+post.id+': 画像のOCR未設定・要確認');failed=true;uncertainShops.push(shop);continue}
    try{extracted=extracted.concat(tv2PickupOffersFromText_(tv2VisionText_(photo.url,vision),lots))}catch(err){errors.push(shop+' '+post.id+': '+String(err));failed=true;uncertainShops.push(shop)}
   }
   if(failed)break;
   if(hadPhoto&&!extracted.length&&/金額に変更/.test(post.text)){errors.push(shop+' '+post.id+': 画像の商品・状態・価格を確定できず要確認。'+ 'https://x.com/'+handle+'/status/'+post.id);uncertainShops.push(shop)}
   for(const item of extracted){const duplicate=offers.find(o=>o.shop===shop&&o.name===item.name&&o.category===item.category&&o.condition===item.condition&&o.postId===post.id);
    if(duplicate&&duplicate.price!==item.price){errors.push(shop+' '+post.id+': 同一商品・状態で価格が複数・要確認');uncertainShops.push(shop);offers.splice(offers.indexOf(duplicate),1);continue}
    if(!duplicate)offers.push(Object.assign(item,{shop,date,postId:post.id,url:'https://x.com/'+handle+'/status/'+post.id}));
   }
   seen[handle]=post.id;
  }
 }catch(err){errors.push(shop+': X追加投稿取得失敗 '+String(err));uncertainShops.push(shop)}}
 health.xUserIds=ids;health.xLastSeen=seen;
 health.xUncertainShops=[...new Set(uncertainShops)];
 return{offers:offers.filter(o=>!uncertainShops.includes(o.shop)),errors,uncertainShops:health.xUncertainShops,status:errors.length?'review':'ok'}
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
function runTv2PickupAuto(){return runTv2MarketAuto()}
function tv2EnsurePickupSchedule_(){if(typeof ScriptApp==='undefined'||typeof PropertiesService==='undefined')return;
 const p=PropertiesService.getScriptProperties(),enabled=Boolean(p.getProperty('TV2_X_BEARER_TOKEN')&&p.getProperty('TV2_VISION_API_KEY'));
 const existing=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='runTv2PickupAuto');
 if(!enabled){existing.forEach(t=>ScriptApp.deleteTrigger(t));return}
 if(existing.length===2)return;
 existing.forEach(t=>ScriptApp.deleteTrigger(t));
 [19,22].forEach(hour=>ScriptApp.newTrigger('runTv2PickupAuto').timeBased().atHour(hour).nearMinute(0).everyDays(1).inTimezone(TZ).create());
}
function tv2PreviousDate_(date){const d=new Date(String(date)+'T12:00:00+09:00');d.setDate(d.getDate()-1);return Utilities.formatDate(d,TZ,'yyyy-MM-dd')}
function tv2FindQuote_(state,lot){return(state.marketQuotes||[]).find(q=>String(q.lotId||'')===String(lot.id||'')&&String(q.condition||'')===String(lot.condition||''))||(state.marketQuotes||[]).find(q=>!q.lotId&&normalize_(q.productKey||q.product)===normalize_(lot.productKey||lot.product)&&String(q.condition||'')===String(lot.condition||''))}
function tv2Health_(state){state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};state.automation.health=state.automation.health&&typeof state.automation.health==='object'?state.automation.health:{};return state.automation.health}
function tv2Config_(){const p=PropertiesService.getScriptProperties(),url=String(p.getProperty(TV2_SYNC_URL_PROP)||''),token=String(p.getProperty('TV_V2_SYNC_TOKEN')||''),alternate=String(p.getProperty(TV2_SYNC_TOKEN_PROP)||'');if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url))throw new Error('TV2_SYNC_URL が未設定です');const tokens=[...new Set([token,alternate].filter(t=>t.length>=24))];if(!tokens.length)throw new Error('V2同期トークンが未設定です');return{url,tokens}}
function tv2ParseResponse_(raw){const text=String(raw||'').trim();if(!text)throw new Error('V2 API empty response');let json=text;const m=text.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*([\s\S]*)\s*\)\s*;?$/);if(m)json=m[1].trim();try{return JSON.parse(json)}catch(e){throw new Error('V2 API response is not JSON/JSONP')}}
function tv2Call_(body){const c=tv2Config_();for(const token of c.tokens){const r=UrlFetchApp.fetch(c.url,{method:'post',contentType:'text/plain;charset=utf-8',payload:JSON.stringify(Object.assign({token},body)),muteHttpExceptions:true});const j=tv2ParseResponse_(r.getContentText());if(j.ok)return j;if(/unauthorized|認証に失敗/i.test(String(j.error||'')))continue;throw new Error(j.error||'V2 API error')}throw new Error('V2 API 認証に失敗しました。同期URLとスクリプトプロパティを確認してください')}
function tv2Load_(){const j=tv2Call_({action:'load'});if(!j.payload||Number(j.payload.schemaVersion)!==2)throw new Error('V2正本ではありません');return j}
function tv2Mutate_(kind,fn){const lock=LockService.getScriptLock();if(!lock.tryLock(30000))return{skipped:true,reason:'locked'};try{const before=tv2Load_(),next=JSON.parse(JSON.stringify(before.payload)),result=fn(next)||{};if(result.changed===false)return Object.assign({revision:Number(before.revision),unchanged:true},result);next.revision=Number(before.revision)+1;next.lastMutationId=kind+'-'+Utilities.getUuid();next.auditLog=Array.isArray(next.auditLog)?next.auditLog:[];next.auditLog.push({mutationId:next.lastMutationId,revision:next.revision,type:kind,at:new Date().toISOString()});tv2Call_({expectedRevision:before.revision,mutationId:next.lastMutationId,payload:next});const check=tv2Load_();if(Number(check.revision)!==next.revision||check.lastMutationId!==next.lastMutationId)throw new Error('V2保存後検証失敗');return Object.assign({revision:check.revision},result)}finally{lock.releaseLock()}}


function runTv2ChatSale(command){
 const input=command&&typeof command==='object'?command:{};
 const product=String(input.product||'').trim(),store=String(input.store||'').trim(),category=String(input.category||'BOX').trim();
 const condition=String(input.condition||'').trim(),date=String(input.date||Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')).trim();
 const quantity=Number(input.quantity),unitPrice=Number(input.unitPrice),requestId=String(input.requestId||'').trim();
 if(!product||!store||!requestId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<=0)throw new Error('チャット売却データが不正です');
 if(!['BOX','パック','カード'].includes(category))throw new Error('チャット売却カテゴリが不正です');
 return tv2Mutate_('chat-sale',state=>{
  const txId='chat-sale-'+requestId;
  const existing=(state.transactions||[]).filter(t=>t.id===txId);
  if(existing.length===1)return{duplicate:true,transactionId:txId,changed:false};
  if(existing.length>1)throw new Error('同一チャット売却IDが重複しています');
  const key=normalize_(product),lots=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&l.category===category&&normalize_(l.productKey||l.product)===key&&(!condition||String(l.condition||'')===condition));
  if(!condition&&new Set(lots.map(l=>String(l.condition||''))).size>1)throw new Error('V2正本の対象在庫の状態が複数あるため条件指定が必要です');
  const available=lots.reduce((n,l)=>n+Number(l.quantity||0),0);
  if(available<quantity)throw new Error('V2正本の対象在庫が不足しています');
  let remaining=quantity,cost=0,unknownCost=false;
  lots.sort((a,b)=>String(a.acquiredAt||'').localeCompare(String(b.acquiredAt||''))||String(a.id||'').localeCompare(String(b.id||'')));
  for(const lot of lots){if(!remaining)break;const take=Math.min(Number(lot.quantity||0),remaining),c=lot.unitCost;if(c===null||c===undefined||c===''||!Number.isFinite(Number(c)))unknownCost=true;else cost+=take*Number(c);lot.quantity=Number(lot.quantity)-take;remaining-=take}
  state.inventoryLots=state.inventoryLots.filter(l=>Number(l.quantity)>0);
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.transactions.push({id:txId,type:'sale',product,productKey:product,category,condition,quantity,price:unitPrice,date,store,soldTo:store,source:'chat',requestId,acquisitionCost:unknownCost?null:cost});
  return{duplicate:false,transactionId:txId,changed:true};
 });
}

function runTv2ChatPurchase(command){
 const input=command&&typeof command==='object'?command:{};
 const product=String(input.product||'').trim(),category=String(input.category||'BOX').trim(),condition=String(input.condition||'').trim(),store=String(input.store||'').trim(),date=String(input.date||Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')).trim();
 const quantity=Number(input.quantity),unitCost=Number(input.unitCost),requestId=String(input.requestId||'').trim();
 if(!product||!requestId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(quantity)||quantity<=0||!Number.isFinite(unitCost)||unitCost<0)throw new Error('チャット購入データが不正です');
 if(!['BOX','パック','カード'].includes(category))throw new Error('チャット購入カテゴリが不正です');
 return tv2Mutate_('chat-purchase',state=>{
  const txId='chat-purchase-'+requestId,existing=(state.transactions||[]).filter(t=>t.id===txId);
  if(existing.length===1)return{duplicate:true,transactionId:txId,changed:false};
  if(existing.length>1)throw new Error('同一チャット購入IDが重複しています');
  const lotId=txId+'-lot';state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  if(state.inventoryLots.some(l=>l.id===lotId))throw new Error('同一チャット購入lotが既に存在します');
  state.inventoryLots.push({id:lotId,product,productKey:product,category,condition,quantity,unitCost,acquiredAt:date,store,source:'chat',requestId});
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.transactions.push({id:txId,type:'purchase',product,productKey:product,category,condition,quantity,price:unitCost,date,store,source:'chat',requestId});
  return{duplicate:false,transactionId:txId,lotId,changed:true};
 });
}

function tv2ProcessChatTradeDrafts_(){
 const subject='[Toreca Vault Command]';
 const drafts=GmailApp.getDrafts().filter(d=>String(d.getMessage().getSubject()||'').trim()===subject);
 const results=[];
 drafts.forEach(draft=>{
  const raw=String(draft.getMessage().getPlainBody()||'').trim();
  let command;try{command=JSON.parse(raw)}catch(e){throw new Error('Toreca Vaultコマンド下書きがJSONではありません')}
  if(!command||!['sale','purchase'].includes(String(command.type||'')))throw new Error('Toreca Vaultコマンド種別が不正です');
  const result=command.type==='sale'?runTv2ChatSale(command):runTv2ChatPurchase(command);
  draft.deleteDraft();
  results.push(result);
 });
 return results;
}


function runTv2StatusSnapshot(){
 const loaded=tv2Load_(),state=loaded.payload||{},requestId='20260926-30th-celebration-mimi-24100-1';
 const transaction=(state.transactions||[]).find(t=>String(t.requestId||'')===requestId)||null;
 const health=state.automation&&state.automation.health?state.automation.health:{};
 const snapshot={revision:Number(loaded.revision),transaction,lastMarketRunAt:health.lastMarketRunAt||'',marketReview:Number(health.marketReview||0),marketStatus:health.marketStatus||'',marketNeedsReview:Array.isArray(health.marketNeedsReview)?health.marketNeedsReview.length:0,lastGmailRunAt:health.lastGmailRunAt||'',gmailReview:Number(health.gmailReview||0),gmailStatus:health.gmailStatus||''};
 GmailApp.sendEmail('manato.pt@gmail.com','[Toreca Vault V2 Status]',JSON.stringify(snapshot));
 return snapshot;
}
