// Simple free-only automation: Gmail every 15 minutes; market once daily after 13:30 JST.
const TV2_SYNC_URL_PROP='TV2_SYNC_URL';
const TV2_SYNC_TOKEN_PROP='TV2_SYNC_TOKEN';
const TV2_STORES=['買取ミミ','AMTAF','アリウム'];
const TV2_OPENING_COMMAND_V2='opening-acquire-v2';

function installTv2Automation(){
  tv2EnsureSimpleAutomationSchedule_(true);
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='runTv2AutomationBootstrap_').forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runTv2AutomationBootstrap_').timeBased().after(15000).create();
  return tv2AutomationStatus();
}
function tv2AutomationStatus(){
  const handlers=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction());
  return{ok:true,handlers,recurring:handlers.filter(x=>x==='runTv2Automation').length,bootstrap:handlers.filter(x=>x==='runTv2AutomationBootstrap_').length,schedule:'15分ごと',market:'13:30以降に1日1回'};
}
function runTv2AutomationBootstrap_(){
  try{return runTv2Automation()}
  finally{ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='runTv2AutomationBootstrap_').forEach(t=>ScriptApp.deleteTrigger(t))}
}
function tv2EnsureSimpleAutomationSchedule_(force){
  if(typeof ScriptApp==='undefined'||typeof PropertiesService==='undefined')return;
  const version='simple-15m-market-1330-v3',handler='runTv2Automation';
  const managed=['runTv2Automation','runTv2LotteryAuto','runTv2MarketAuto','runTv2PickupAuto','runTorecaVaultLotterySync','runTorecaVaultMarketSync'];
  const props=PropertiesService.getScriptProperties(),triggers=ScriptApp.getProjectTriggers();
  const ours=triggers.filter(t=>managed.includes(t.getHandlerFunction()));
  const simple=ours.filter(t=>t.getHandlerFunction()===handler);
  if(!force&&props.getProperty('TV2_AUTOMATION_SCHEDULE')===version&&ours.length===1&&simple.length===1)return;
  ours.forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(15).create();
  props.setProperty('TV2_AUTOMATION_SCHEDULE',version);
}
function runTv2Automation(){
  tv2EnsureSimpleAutomationSchedule_(false);
  const gmail=runTv2LotteryAuto({skipScheduleEnsure:true});
  const hour=Number(Utilities.formatDate(new Date(),TZ,'H')),minute=Number(Utilities.formatDate(new Date(),TZ,'m'));
  let market={skipped:true,reason:'before-13:30'};
  if(hour>13||(hour===13&&minute>=30))market=runTv2MarketAuto({skipQueue:true,scheduled:true,skipScheduleEnsure:true});
  return{ok:true,gmail,market};
}
function runTv2LotteryAuto(options){
  if(!(options&&options.skipScheduleEnsure))tv2EnsureSimpleAutomationSchedule_(false);
  if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
  return tv2Mutate_('gmail-auto',state=>{
    const now=new Date(),health=tv2Health_(state),last=health.lastGmailRunAt?new Date(health.lastGmailRunAt):null;
    const parserVersion='gmail-efficient-v7',parserChanged=String(health.gmailParserVersion||'')!==parserVersion;
    // Keep a bounded overlap for late delivery without rereading two full days
    // of Gmail every 15 minutes. Parser upgrades get one provider-scoped pass.
    const since=parserChanged?new Date(now.getTime()-7*86400000):(last&&!isNaN(last.getTime())?new Date(last.getTime()-6*3600000):new Date(now.getTime()-24*3600000));
    const processed=new Set(parserChanged?[]:(health.gmailMessageIds||[])),newIds=[],reviews=[];let changed=false;
    const report={updated:0,created:0,duplicate:0,outside:0,review:0,scanned:0,at:now.toISOString()};
    const after='after:'+Math.floor(since.getTime()/1000);
    const query=parserChanged
      ? after+' {from:info@pokemoncenter-online.com from:noreply@ml.yamada-denki.jp from:noreply@livepocket.jp}'
      : after+' {抽選 当選 落選 応募 申込}',threads=[];
    for(let offset=0;offset<500;offset+=100){
      const page=GmailApp.search(query,offset,100);
      threads.push(...page);
      if(page.length<100)break;
      if(offset===400)throw new Error('Gmail検索が500スレッドを超えました。検索条件を確認してください');
    }
    threads.forEach(th=>th.getMessages().forEach(message=>{
      if(message.getDate()<=since)return;const id=message.getId();if(processed.has(id))return;
      const text=[message.getSubject(),message.getPlainBody()].join('\n'),normalizedText=String(text).normalize('NFKC'),isApplication=tv2IsApplicationMessage_(message,text),isResult=tv2IsResultMessage_(message,text);
      if(!CARD_WORDS.test(normalizedText)||(!isResult&&!isApplication))return;report.scanned++;
      if(isApplication){
        const before=state.lotteries.length,r=upsertApplication_(state.lotteries,text,message,now);
        if(r.kind==='created'){report.created++;changed=true}else if(r.kind==='updated'){report.updated++;changed=true}else if(r.kind==='duplicate')report.duplicate++;else{report.review++;reviews.push({messageId:id,reason:r.reason,subject:message.getSubject()})}
        newIds.push(id);return;
      }
      const pokemonCenter=tv2ResolvePokemonCenterResult_(state,message,text,now);
      if(pokemonCenter){
        if(pokemonCenter.kind==='created'){report.created++;changed=true}
        else if(pokemonCenter.kind==='updated'){report.updated++;changed=true}
        else if(pokemonCenter.kind==='duplicate')report.duplicate++;
        else{report.review++;reviews.push({messageId:id,reason:pokemonCenter.reason,subject:message.getSubject()})}
        newIds.push(id);return;
      }
      const geo=tv2ResolveGeoResult_(state,message,text,now);
      if(geo){
        if(geo.kind==='created'){report.created++;changed=true}
        else if(geo.kind==='updated'){report.updated++;changed=true}
        else if(geo.kind==='duplicate')report.duplicate++;
        else{report.review++;reviews.push({messageId:id,reason:geo.reason,subject:message.getSubject()})}
        newIds.push(id);return;
      }
      const match=matchLottery_(state.lotteries,text);
      if(match.kind==='outside')report.outside++;else if(match.kind==='review'){report.review++;reviews.push({messageId:id,reason:match.reason,subject:message.getSubject()})}else{
        const parsed=parseResult_(text,message.getDate());if(!parsed.status){report.review++;reviews.push({messageId:id,reason:'当落を一意に判別できない',subject:message.getSubject()})}
        else{
          const item=match.item,old=JSON.stringify(item);
          if(typeof applyLivePocketMetadata_==='function')applyLivePocketMetadata_(item,text,message,now);
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
    health.gmailMessageIds=[...processed,...newIds].slice(-3000);health.gmailParserVersion=parserVersion;health.lastGmailRunAt=now.toISOString();health.gmailReview=report.review;health.gmailStatus=report.review?'review':'ok';health.gmailNeedsReview=[...(health.gmailNeedsReview||[]),...reviews].slice(-200);
    return {changed:true,report};
  });
}





function tv2ResolvePokemonCenterResult_(state,message,text,now){
 const from=String(message&&message.getFrom?message.getFrom():'');
 const subject=String(message&&message.getSubject?message.getSubject():'');
 const source=[from,subject,String(text||'')].join('\n');
 if(!/pokemoncenter-online\.com|ポケモンセンターオンライン/i.test(source)||!/当選|落選|抽選結果/.test(source))return null;
 const parsed=parseResult_(text,message.getDate());
 if(!parsed.status)return{kind:'review',reason:'ポケモンセンターの当落を一意に判別できない'};
 const title=extractPokemonCenterTitle_(text),code=extractPokemonCenterProductCode_(text);
 if(!title)return{kind:'review',reason:'ポケモンセンター結果メールから商品名を抽出できない'};
 const all=state.lotteries||[],productCandidates=all.filter(x=>
   normalize_(x.store||'')===normalize_('ポケモンセンターオンライン')&&
   productMatches_(productKey_(x.title||''),productKey_(title))
 );
 const byCode=code?productCandidates.filter(x=>String(x.id||'').includes(code)||String(x.memo||'').includes(code)):[];
 const sameDate=productCandidates.filter(x=>String(x.resultDate||'')===String(parsed.resultDate||''));
 const pendingSameDate=sameDate.filter(x=>['応募済','応募済み'].includes(String(x.status||'')));
 const preferredManual=pendingSameDate.filter(x=>!/自動登録｜申込番号 pokemoncenter-/.test(String(x.memo||''))&&!/lottery-livepocket-pokemoncenter-/.test(String(x.id||'')));
 let candidates=byCode.length?byCode:(preferredManual.length===1?preferredManual:(pendingSameDate.length?pendingSameDate:productCandidates));
 if(candidates.length>1&&preferredManual.length===1)candidates=preferredManual;
 if(candidates.length>1)return{kind:'review',reason:'ポケモンセンター結果メールに一致する登録済み抽選が複数あります'};
 let item=candidates[0];
 if(!item){
   item={
     id:'lottery-pokemoncenter-'+(code||message.getId()),
     title:title,
     store:'ポケモンセンターオンライン',
     status:parsed.status,
     resultDate:parsed.resultDate||'',
     receiveDeadline:parsed.receiveDeadline||'',
     receiptStatus:parsed.status==='当選'?'未受取':'対象外',
     receivedDate:'',
     memo:'自動登録｜ポケモンセンターオンライン'+(code?'｜商品コード '+code:''),
     gmailMessageId:message.getId(),
     createdAt:now.toISOString(),
     updatedAt:now.toISOString()
   };
   state.lotteries.push(item);return{kind:'created',item};
 }
 const old=JSON.stringify(item);
 if(typeof applyPokemonCenterMetadata_==='function')applyPokemonCenterMetadata_(item,text,message,now);
 const conflict=(parsed.status==='落選'&&(['当選','購入済'].includes(item.status)||item.receiptStatus==='受取済み'))||
   (parsed.status==='当選'&&item.status==='落選');
 if(conflict)return{kind:'review',reason:'既存の当落・購入・受取状態とポケモンセンター結果メールが競合'};
 if(['応募済','応募済み'].includes(item.status))item.status=parsed.status;
 item.resultDate=parsed.resultDate||item.resultDate;
 if(parsed.receiveDeadline)item.receiveDeadline=parsed.receiveDeadline;
 if(parsed.status==='当選'&&!['受取済み','未受取'].includes(item.receiptStatus))item.receiptStatus='未受取';
 if(parsed.status==='落選'&&item.receiptStatus!=='受取済み')item.receiptStatus='対象外';
 item.updatedAt=now.toISOString();

 // Remove only parser-created pending duplicates for the same product/date after
 // a unique canonical record has been selected.
 state.lotteries=all.filter(x=>{
   if(x===item)return true;
   if(!/lottery-livepocket-pokemoncenter-/.test(String(x.id||'')))return true;
   if(!['応募済','応募済み'].includes(String(x.status||'')))return true;
   if(String(x.resultDate||'')!==String(item.resultDate||''))return true;
   if(normalize_(x.store||'')!==normalize_('ポケモンセンターオンライン'))return true;
   return !productMatches_(productKey_(x.title||''),productKey_(item.title||''));
 });
 return{kind:JSON.stringify(item)===old?'duplicate':'updated',item};
}

function tv2ResolveGeoResult_(state,message,text,now){
 const from=String(message&&message.getFrom?message.getFrom():'');
 const subject=String(message&&message.getSubject?message.getSubject():'');
 if(!/geonet\.jp/i.test(from)||!/当選ならびにご購入手続き/.test(subject))return null;
 const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const after=label=>{const i=lines.findIndex(x=>x===label);return i>=0&&i+1<lines.length?lines[i+1]:''};
 const title=after('[当選した商品]'),store=after('[受取店舗名]');
 if(!title||!store)return{kind:'review',reason:'GEO当選メールから商品名または受取店舗名を抽出できない'};
 const titleKey=productKey_(title);
 const candidates=(state.lotteries||[]).filter(x=>{
   const tk=productKey_(x.title||''),sk=normalize_(x.store||'');
   return tk&&productMatches_(titleKey,tk)&&(/geo|ゲオ/.test(sk));
 });
 if(candidates.length>1)return{kind:'review',reason:'GEO当選メールに一致する登録済み抽選が複数あります'};
 const parsed=parseResult_(text,message.getDate());
 if(parsed.status!=='当選')return{kind:'review',reason:'GEO当選メールの当選判定に失敗'};
 let item=candidates[0];
 if(!item){
   item={id:'lottery-geo-'+message.getId(),title:cleanLotteryTitle_(title),store:cleanStoreName_(store),status:'当選',resultDate:parsed.resultDate||'',receiptStatus:'未受取',receivedDate:'',memo:'自動登録｜GEO当選メール',gmailMessageId:message.getId(),createdAt:now.toISOString(),updatedAt:now.toISOString()};
   state.lotteries.push(item);return{kind:'created',item};
 }
 const old=JSON.stringify(item);
 item.store=cleanStoreName_(store);
 if(['応募済','応募済み'].includes(item.status))item.status='当選';
 item.resultDate=parsed.resultDate||item.resultDate;
 if(item.receiptStatus!=='受取済み')item.receiptStatus='未受取';
 item.gmailMessageId=message.getId();item.updatedAt=now.toISOString();
 return{kind:JSON.stringify(item)===old?'duplicate':'updated',item};
}

function tv2IsApplicationMessage_(message,text){
 const subject=String(message&&message.getSubject?message.getSubject():'');
 if(/(?:抽選申込完了|申込受付完了|抽選販売応募完了|応募完了|申込完了|申込み完了|申込み受付が完了|お申込み受付が完了|抽選販売へのお申込み受付)/.test(subject))return true;
 return APPLICATION_WORDS.test(subject)||(APPLICATION_WORDS.test(String(text||''))&&!RESULT_WORDS.test(subject));
}

function tv2IsResultMessage_(message,text){
 const subject=String(message&&message.getSubject?message.getSubject():'');
 return RESULT_WORDS.test(subject);
}



function tv2CardVariant_(lot){
 const text=normalize_([lot&&lot.variant,lot&&lot.set,lot&&lot.product].filter(Boolean).join(' '));
 if(text.includes(normalize_('マスターボールミラー')))return'マスターボールミラー';
 if(text.includes(normalize_('モンスターボールミラー')))return'モンスターボールミラー';
 if(text.includes(normalize_('ミラー')))return'ミラー';
 if(text.includes(normalize_('通常版')))return'通常版';
 return'';
}


function tv2RepairKnownCardIdentities20260928_(){
 return tv2Mutate_('card-identity-clarification',state=>{
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  const specs=[
   {name:'ニョロモ',number:'060/165',set:'SV2a 060/165',variant:'マスターボールミラー'},
   {name:'メガリザードンex',number:'223/193',set:'M2a 223/193',variant:'通常版'}
  ];
  const changes=[],matched=[];
  for(const spec of specs){
   const matches=state.inventoryLots.filter(l=>{
    if(Number(l.quantity)<=0||l.category!=='カード')return false;
    const combined=normalize_(String(l.product||'')+' '+String(l.productKey||'')+' '+String(l.set||''));
    return combined.includes(normalize_(spec.name))&&combined.includes(normalize_(spec.number));
   });
   if(matches.length!==1)throw new Error(spec.name+' '+spec.number+' の在庫を一意に特定できません: '+matches.length+'件');
   const lot=matches[0],before={product:lot.product,set:lot.set||'',variant:lot.variant||'',identityNeedsReview:lot.identityNeedsReview===true};
   lot.product=spec.name;lot.productKey=spec.name;lot.set=spec.set;lot.variant=spec.variant;lot.identityNeedsReview=false;lot.identityConfirmedAt='2026-09-28';lot.identityConfirmedBy='user';
   changes.push({lotId:lot.id,before,after:{product:lot.product,set:lot.set,variant:lot.variant,identityNeedsReview:false}});
   matched.push(lot.id);
  }
  return{changed:true,changes,matched};
 });
}

function tv2RepairKnownCardsNow_(){
 const identity=tv2RepairKnownCardIdentities20260928_();
 const market=runTv2MarketAuto({skipQueue:true,singleOnly:true});
 const loaded=tv2Load_(),state=loaded.payload||{};
 const targets=(state.inventoryLots||[]).filter(l=>{
  const combined=normalize_(String(l.product||'')+' '+String(l.set||''));
  return (combined.includes(normalize_('ニョロモ'))&&combined.includes(normalize_('060/165')))||
         (combined.includes(normalize_('メガリザードンex'))&&combined.includes(normalize_('223/193')));
 }).map(l=>{
  const q=(state.marketQuotes||[]).filter(x=>String(x.lotId||'')===String(l.id||'')).sort((a,b)=>String(b.checkedAt||'').localeCompare(String(a.checkedAt||'')))[0]||null;
  return{lotId:l.id,product:l.product,set:l.set||'',variant:l.variant||'',identityNeedsReview:l.identityNeedsReview===true,quote:q?{price:q.price,source:q.source,checkedAt:q.checkedAt}:null};
 });
 if(targets.length!==2)throw new Error('修正対象2件の再読込検証に失敗しました: '+targets.length+'件');
 const poliwag=targets.find(x=>normalize_(x.product).includes(normalize_('ニョロモ')));
 const charizard=targets.find(x=>normalize_(x.product).includes(normalize_('メガリザードンex')));
 if(!poliwag||poliwag.variant!=='マスターボールミラー'||poliwag.identityNeedsReview)throw new Error('ニョロモの版指定検証に失敗しました');
 if(!charizard||charizard.variant!=='通常版'||charizard.identityNeedsReview)throw new Error('メガリザードンexの版指定検証に失敗しました');
 return{ok:true,revision:Number(loaded.revision),identity,market,targets};
}


function tv2CardSetText_(lot,model){
 const direct=String(lot&&lot.set||'').trim();if(direct)return direct;
 const source=String(lot&&(lot.product||lot.productKey)||'').trim();if(!source||!model)return'';
 const parts=source.split(/\s+/),index=parts.findIndex(p=>normalize_(p)===normalize_(model));
 if(index<=0)return'';
 const code=String(parts[index-1]||'');
 if(!/^[A-Za-z0-9-]{1,12}$/.test(code)||/^(?:EX|GX|V|VMAX|VSTAR)$/i.test(code))return'';
 return code+' '+model;
}
function tv2CardMarketName_(lot,model){
 let name=String(lot.product||lot.productKey||'').trim();
 if(model)name=name.replace(String(model),' ').replace(/\s+/g,' ').trim();
 const setCode=tv2CardSetText_(lot,model).split(/\s+/)[0]||'',parts=name.split(/\s+/);
 if(setCode&&parts.length>1&&normalize_(parts[parts.length-1])===normalize_(setCode))parts.pop();
 return parts.join(' ').trim();
}
function tv2NormalizeCardLotForV2Only_(lot){
 if(!lot||lot.category!=='カード')return false;
 const model=extractModel_([lot.set,lot.product,lot.productKey].filter(Boolean).join(' '));if(!model)return false;
 let changed=false,setText=tv2CardSetText_(lot,model);
 if(!String(lot.set||'').trim()&&setText){lot.set=setText;changed=true}
 const setCode=String(lot.set||setText||'').trim().split(/\s+/)[0]||'';
 const parts=String(lot.product||'').trim().split(/\s+/),idx=parts.findIndex(p=>normalize_(p)===normalize_(model));
 if(idx>0&&setCode&&normalize_(parts[idx-1])===normalize_(setCode)){
   const next=parts.slice(0,idx-1).concat(parts.slice(idx+1)).join(' ').trim();
   if(next&&next!==lot.product){lot.product=next;changed=true}
 }
 return changed;
}
function tv2CleanCutover20260928_(){
 const version='20260928-v2-only-v1',before=tv2Load_(),beforeState=before.payload||{},beforeHealth=(beforeState.automation&&beforeState.automation.health)||{};
 if(String(beforeHealth.v2OnlyCutoverVersion||'')===version){
  const active=(beforeState.inventoryLots||[]).filter(l=>Number(l.quantity)>0),cards=active.filter(l=>l.category==='カード'),quotes=Array.isArray(beforeState.marketQuotes)?beforeState.marketQuotes:[],today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd');
  const fresh=cards.filter(l=>quotes.some(q=>String(q.lotId||'')===String(l.id||'')&&String(q.checkedAt||'')===today&&Number(q.price)>0)).length;
  return{ok:true,already:true,revision:Number(before.revision),counts:{activeLots:active.length,cards:cards.length,marketQuotes:quotes.length,freshCardQuotes:fresh}};
 }
 const reset=tv2Mutate_('v2-only-clean-cutover',state=>{
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  const removedQuotes=Array.isArray(state.marketQuotes)?state.marketQuotes.length:0;
  state.marketQuotes=[];
  let normalizedCards=0;
  state.inventoryLots.forEach(l=>{if(tv2NormalizeCardLotForV2Only_(l))normalizedCards++});
  const health=tv2Health_(state);health.marketStatus='pending';health.marketReview=0;health.marketNeedsReview=[];health.v2OnlyCutoverVersion=version;health.v2OnlyCutoverAt=new Date().toISOString();
  return{changed:true,removedQuotes,normalizedCards};
 });
 const market=runTv2MarketAuto({skipQueue:true});
 const loaded=tv2Load_(),state=loaded.payload||{},today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd');
 const activeLots=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0),cards=activeLots.filter(l=>l.category==='カード');
 const quotes=Array.isArray(state.marketQuotes)?state.marketQuotes:[];
 const freshCardQuotes=cards.filter(l=>quotes.some(q=>String(q.lotId||'')===String(l.id||'')&&String(q.checkedAt||'')===today&&Number(q.price)>0)).length;
 return{ok:true,already:false,revision:Number(loaded.revision),reset,market,counts:{activeLots:activeLots.length,cards:cards.length,marketQuotes:quotes.length,freshCardQuotes}};
}

function tv2TryMarketSource_(label,fn,reviews){
 try{return fn()||null}catch(err){reviews.push(label+'取得失敗: '+String(err&&err.message||err));return null}
}

function runTv2MarketAuto(options){
 if(!(options&&options.skipQueue)&&typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
 const outcome=tv2Mutate_('market-auto',state=>{const now=new Date(),health=tv2Health_(state),reviews=[];const date=Utilities.formatDate(now,TZ,'yyyy-MM-dd'),policy='cardrush-toretoku-v3',report={updated:0,unchanged:0,review:0,cardUpdated:0,cardUnchanged:0,cardReview:0,cardTotal:0,at:now.toISOString()};
  if(options&&options.scheduled&&String(health.lastScheduledMarketDate||'')===date&&String(health.marketPolicyVersion||'')===policy)return{changed:false,skipped:true,reason:'already-ran-today',report};
  const cards=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&l.category==='カード');report.cardTotal=cards.length;
  let rows=null;
  if(cards.length){try{rows=fetchCardrushRows_()}catch(err){reviews.push('カードラッシュCSV取得失敗: '+String(err))}}
  const seen=new Set();
  cards.forEach(lot=>{
    const key=String(lot.id||normalize_(lot.productKey||lot.product)+'|'+String(lot.condition||''));
    if(seen.has(key))return;seen.add(key);
    if(lot.identityNeedsReview===true){report.review++;report.cardReview++;reviews.push(lot.product+': カード番号は買取価格からの推定・現物確認まで前回価格維持');return}
    const model=extractModel_([lot.set,lot.product].filter(Boolean).join(' '));
    // The public buyback list describes standard condition. Other card conditions
    // cannot be priced from it without guessing a discount.
    if(!model||!['良品','美品',''].includes(String(lot.condition||''))){
      report.review++;report.cardReview++;reviews.push(lot.product+': 型番・状態を確認できず前回価格維持');return;
    }
    const name=tv2CardMarketName_(lot,model),setText=tv2CardSetText_(lot,model),variant=tv2CardVariant_(lot);
    // Every source is exact-match and fail-closed. One unavailable source must
    // not abort the remaining inventory refresh.
    let result=rows&&name?tv2TryMarketSource_('カードラッシュCSV',()=>findCardrushBuyback_(rows,name,model,variant),reviews):null;
    if((!result||!Number.isFinite(result.price)||result.price<=0)&&name)result=tv2TryMarketSource_('カードラッシュ',()=>fetchCardrushMediaBuyback_(name,model,variant),reviews);
    if((!result||!Number.isFinite(result.price)||result.price<=0)&&name)result=tv2TryMarketSource_('トレトク',()=>fetchToretokuBuyback_(name,setText,model,variant),reviews);
    if(!result||!Number.isFinite(result.price)||result.price<=0){
      report.review++;report.cardReview++;reviews.push(lot.product+' '+model+(variant?' '+variant:'')+': 完全一致の買取価格なし・前回価格維持');return;
    }
    const quote=tv2FindQuote_(state,lot);
    if(quote&&String(quote.checkedAt||'')>date){report.unchanged++;report.cardUnchanged++;return}
    const old=quote?Number(quote.price):result.price;
    const target=quote||{lotId:lot.id,product:lot.product,productKey:lot.productKey,category:lot.category,condition:lot.condition};
    target.previousPrice=Number.isFinite(old)?old:result.price;
    target.price=result.price;target.checkedAt=date;target.source=String(result.source||'カードラッシュ');target.fresh=true;
    target.trend=result.price>target.previousPrice?'up':result.price<target.previousPrice?'down':'same';
    target.history=Array.isArray(target.history)?target.history:[];
    if(!target.history.some(h=>String(h.checkedAt||h.date)===date&&Number(h.price??h.value)===result.price))
      target.history.push({date,value:result.price,source:target.source});
    target.history=target.history.slice(-400);
    if(!quote)state.marketQuotes.push(target);
    if(quote&&old===result.price){report.unchanged++;report.cardUnchanged++}else{report.updated++;report.cardUpdated++}
  });
  if(options&&options.singleOnly){
    health.lastMarketRunAt=now.toISOString();health.marketReview=report.review;health.marketStatus=report.review?'review':'ok';health.marketNeedsReview=reviews.slice(-200);
    return{changed:true,report};
  }
  let feed={products:[],error:''};
  const sealed=(state.inventoryLots||[]).filter(l=>Number(l.quantity)>0&&['BOX','パック'].includes(l.category));
  if(sealed.length){try{
    const response=UrlFetchApp.fetch('https://torekakaku-navi.com/',{muteHttpExceptions:true,followRedirects:true});
    if(response.getResponseCode()!==200)throw new Error('HTTP '+response.getResponseCode());
    feed=tv2ParseSealedFeed_(response.getContentText('UTF-8'),date);
  }catch(err){feed={products:[],error:'BOX相場取得失敗: '+String(err)}}}
  if(feed.error)reviews.push(feed.error);
  // Free-only runtime: do not call X API or Vision API. The public sealed-market
  // feed already carries the store X source URLs used for provenance.
  const pickup={offers:[],errors:[],uncertainShops:[],status:'free-public-feed-only'};
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
    const officialUrl=tv2SealedOfficialUrl_(lot.product||lot.productKey);if(officialUrl){target.officialProductUrl=officialUrl;target.officialProductName='ポケモンカードゲーム MEGA スタートデッキ100 バトルコレクション'}
    target.source=best.shop+' '+best.date+' '+best.url+' ('+condition+')';target.fresh=best.date===date&&!pickup.uncertainShops.includes(best.shop);
    target.trend=best.price>target.previousPrice?'up':best.price<target.previousPrice?'down':'same';
    target.history=Array.isArray(target.history)?target.history:[];
    if(!target.history.some(h=>String(h.checkedAt||h.date)===date&&Number(h.price??h.value)===best.price))
      target.history.push({date,value:best.price,source:target.source});
    target.history=target.history.slice(-400);
    if(!quote)state.marketQuotes.push(target);
    if(quote&&previous===best.price)report.unchanged++;else report.updated++;
  });
  health.lastMarketRunAt=now.toISOString();if(options&&options.scheduled){health.lastScheduledMarketDate=date;health.marketPolicyVersion=policy}health.marketReview=report.review;health.marketStatus=report.review?'review':'ok';health.marketNeedsReview=reviews.slice(-200);return{changed:true,report};
 });
 if(!(options&&options.skipScheduleEnsure))tv2EnsureMarketSchedule_();
 return outcome;
}
function tv2SealedName_(s){
 let n=normalize_(String(s||'').replace(/&amp;/g,'&')).replace(/^ポケモンカードゲームmega/,'').replace(/^ポケモンカードゲーム/,'').replace(/^(?:強化拡張|拡張|ハイクラス)パック/,'').replace(/(?:未開封)?(?:box|ボックス)$/,'');
 if(n==='スタートデッキ100'||n==='megaスタートデッキ100'||n==='スタートデッキ100バトルコレクション')return'スタートデッキ100バトルコレクション';
 return n;
}
function tv2IsPremiumDeck_(name){return tv2SealedName_(name)==='30thcelebrationプレミアムデッキセットエーフィブラッキー'}
function tv2IsStartDeck100_(name){return tv2SealedName_(name)==='スタートデッキ100バトルコレクション'}
function tv2IsSealedOther_(name){return tv2IsPremiumDeck_(name)||tv2IsStartDeck100_(name)}
function tv2SealedOfficialUrl_(name){return tv2IsStartDeck100_(name)?'https://www.pokemon-card.com/ex/mc/':''}
function tv2SealedCondition_(lot){const c=normalize_(lot.condition);if(lot.category==='BOX'&&tv2IsSealedOther_(lot.product||lot.productKey))return c==='なし'||c==='シュリンクなし'||c==='開封済み'?'':'shrink';if(lot.category==='BOX')return c==='あり'||c==='シュリンクあり'||c==='シュリンク有'?'shrink':c==='なし'||c==='シュリンクなし'||c==='シュリンク無'?'no_shrink':'';if(lot.category==='パック')return c===''||c==='未開封'||c==='バラパック'?'loose_pack':'';return''}
function tv2ParseSealedFeed_(html,date){
  const text=String(html||'');
  const stamp=text.match(/掲載日\s*<b>(\d{4}-\d{2}-\d{2})<\/b>\s*\/\s*スナップショット\s*(\d{4}-\d{2}-\d{2})/);
  if(!stamp||stamp[1]!==stamp[2]||stamp[1]>date)return{products:[],error:'BOX相場の掲載日・スナップショットを確認できません'};
  const starts=[...text.matchAll(/<div class="card(?:\s[^"]*)?"[^>]*>/g)],products=[];
  const stores={cardshop_allium:'アリウム',amtaf_shop:'AMTAF',mimi_kaitori:'買取ミミ'};
  for(let i=0;i<starts.length;i++){
    const head=starts[i][0];if(!/data-cat="box"/.test(head)&&!(/data-cat="sealed_other"/.test(head)&&tv2IsSealedOther_((head.match(/data-name="([^"]+)"/)||[])[1])))continue;
    const block=text.slice(starts[i].index,starts[i+1]?.index||text.length),name=(head.match(/data-name="([^"]+)"/)||[])[1]||'';
    const official=(block.match(/<span class="official">([^<]+)<\/span>/)||[])[1]||'';
    if(!name||(!official&&!tv2IsSealedOther_(name)))continue;
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
 const sealedOther=lot.category==='BOX'&&tv2IsSealedOther_(lot.product||lot.productKey);
 if(condition==='shrink'&&sealedOther){
   if(/開封済み|中古|シュリンク(?:なし|無)|シュリ(?:なし|無)/.test(normalized))return null;
 }else if(condition==='shrink'&&(!shrink||noShrink))return null;
 else if(condition==='no_shrink'&&(!noShrink||shrink))return null;
 else if(condition==='loose_pack'&&!/(?:バラパック|バラ売り|単品パック)/.test(normalized))return null;
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
function tv2EnsureMarketSchedule_(){tv2EnsureSimpleAutomationSchedule_(false)}
function runTv2PickupAuto(){return runTv2MarketAuto({skipQueue:true})}
function tv2EnsurePickupSchedule_(){
  if(typeof ScriptApp==='undefined')return;
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='runTv2PickupAuto').forEach(t=>ScriptApp.deleteTrigger(t));
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



function tv2NormalizeProductCategory_(product,category){
 const name=String(product||'');
 if(/スタートデッキ|デッキセット|構築済みデッキ/.test(name))return'BOX';
 return String(category||'BOX').trim();
}

function runTv2ChatPurchase(command){
 const input=command&&typeof command==='object'?command:{};
 const product=String(input.product||'').trim(),category=tv2NormalizeProductCategory_(product,input.category),condition=String(input.condition||'').trim(),store=String(input.store||'').trim(),date=String(input.date||Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')).trim();
 const quantity=Number(input.quantity),unitCost=Number(input.unitCost),requestId=String(input.requestId||'').trim();
 const openingBox=String(input.openingBoxProduct||'').trim(),rawCardSet=String(input.cardSet||input.cardCode||'').trim(),cardSet=rawCardSet.replace(/^(M6)\s+(\d{3})-(\d{3})$/,'$1 $2/$3'),rarity=String(input.rarity||'').trim();
 if(!product||!requestId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(quantity)||quantity<=0||!Number.isFinite(unitCost)||unitCost<0)throw new Error('チャット購入データが不正です');
 if(!['BOX','パック','カード'].includes(category))throw new Error('チャット購入カテゴリが不正です');
 if(openingBox&&(category!=='カード'||quantity!==1||!cardSet))throw new Error('開封獲得カード情報が不正です');
 return tv2Mutate_('chat-purchase',state=>{
  const txId='chat-purchase-'+requestId,lotId=txId+'-lot',openingId='chat-opening-'+requestId;
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  const existing=(state.transactions||[]).filter(t=>t.id===txId),openingExisting=state.transactions.filter(t=>t.id===openingId),lotExisting=state.inventoryLots.filter(l=>l.id===lotId);
  if(existing.length===1&&lotExisting.length===1&&(!openingBox||openingExisting.length===1))return{duplicate:true,transactionId:txId,lotId,changed:false};
  if(existing.length||lotExisting.length||openingExisting.length)throw new Error('同一チャット購入IDが部分重複しています');

  let source='chat',memo='';
  if(openingBox){
   const wanted=normalize_(openingBox),boxLots=state.inventoryLots.filter(l=>{if(Number(l.quantity)<=0||l.category!=='BOX')return false;const name=normalize_(l.productKey||l.product);return name===wanted||name.includes(wanted)||wanted.includes(name)});
   if(!boxLots.length)throw new Error('V2正本に開封対象BOX在庫がありません');
   if(new Set(boxLots.map(l=>String(l.condition||''))).size>1)throw new Error('開封対象BOXの状態が複数あるため条件指定が必要です');
   boxLots.sort((a,b)=>String(a.acquiredAt||'').localeCompare(String(b.acquiredAt||''))||String(a.id||'').localeCompare(String(b.id||'')));
   const box=boxLots[0],cost=box.unitCost===null||box.unitCost===undefined||box.unitCost===''?null:Number(box.unitCost);
   box.quantity=Number(box.quantity)-1;state.inventoryLots=state.inventoryLots.filter(l=>Number(l.quantity)>0);
   state.transactions.push({id:openingId,type:'opening',product:openingBox,productKey:openingBox,category:'BOX',condition:String(box.condition||''),quantity:1,price:0,date,source:'chat',memo:'BOX開封',requestId,acquisitionCost:Number.isFinite(cost)?cost:null});
   source='opening';memo='開封獲得'+(rarity?'｜'+rarity:'')+'｜'+openingBox+' 1BOX開封';
  }
  state.inventoryLots.push({id:lotId,product,productKey:product,category,condition,set:category==='カード'?cardSet:'',quantity,unitCost,acquiredAt:date,store,source,requestId,memo});
  state.transactions.push({id:txId,type:'purchase',product,productKey:product,category,condition,set:category==='カード'?cardSet:'',quantity,price:unitCost,total:unitCost*quantity,date,store,source,requestId,memo});
  return{duplicate:false,transactionId:txId,lotId,openingId:openingBox?openingId:'',changed:true};
 });
}



function runTv2ChatLottery(command){
 const input=command&&typeof command==='object'?command:{};
 const title=String(input.title||input.product||'').trim(),store=String(input.store||'').trim(),requestId=String(input.requestId||'').trim();
 const status=String(input.status||'応募済').trim(),deadline=String(input.deadline||'').trim(),resultDate=String(input.resultDate||'').trim(),memo=String(input.memo||'').trim();
 const applicationDate=String(input.applicationDate||Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')).trim();
 if(!title||!store||!requestId||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(applicationDate))throw new Error('チャット抽選データが不正です');
 if(!['応募前','応募済','当選','落選','購入済'].includes(status))throw new Error('チャット抽選状態が不正です');
 if(resultDate&&!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(resultDate))throw new Error('チャット抽選結果日が不正です');
 return tv2Mutate_('chat-lottery',state=>{
  state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  const id='chat-lottery-'+requestId,existing=state.lotteries.filter(x=>x.id===id);
  if(existing.length===1)return{duplicate:true,lotteryId:id,changed:false};
  if(existing.length>1)throw new Error('同一チャット抽選IDが重複しています');
  const now=new Date().toISOString();
  state.lotteries.push({
   id,title,store,status,deadline,resultDate,
   receiptStatus:status==='当選'?'未受取':status==='購入済'?'受取済み':'対象外',
   receivedDate:'',shrinkStatus:'未選択',memo,
   applicationDate,source:'chat',requestId,createdAt:now,updatedAt:now
  });
  return{duplicate:false,lotteryId:id,changed:true};
 });
}



function runTv2PokemonCenterSpouseResult(command){
 const input=command&&typeof command==='object'?command:{};
 const requestId=String(input.requestId||'').trim(),resultDate=String(input.resultDate||'').trim();
 const store='ポケモンセンターオンライン';
 const celebrationTitle='MEGA 拡張パック 30th CELEBRATION BOX';
 const futuristicTitle='MEGA 30th CELEBRATION FUTURISTIC BOX';
 const ownerTag='嫁分';
 if(!requestId||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(resultDate))throw new Error('ポケモンセンター嫁分結果コマンドが不正です');
 const isSpouse=x=>/(嫁分|妻分|奥さん|嫁|妻)/.test([String(x&&x.memo||''),String(x&&x.title||'')].join('｜'))||String(x&&x.owner||'')===ownerTag;
 const isStore=x=>normalize_(x&&x.store||'')===normalize_(store);
 const isCelebration=x=>{
  const t=normalize_(x&&x.title||'');
  return t.includes(normalize_('30th CELEBRATION'))&&!t.includes(normalize_('FUTURISTIC'));
 };
 const isFuturistic=x=>normalize_(x&&x.title||'').includes(normalize_('30th CELEBRATION FUTURISTIC'));
 const appendMemo=(value,parts)=>{
  const out=String(value||'').split('｜').map(s=>s.trim()).filter(Boolean);
  parts.forEach(p=>{if(p&&!out.includes(p))out.push(p)});
  return out.join('｜');
 };
 const result=tv2Mutate_('chat-pokemoncenter-spouse-result',state=>{
  state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};
  state.automation.pokemonCenterSpouseResultIds=Array.isArray(state.automation.pokemonCenterSpouseResultIds)?state.automation.pokemonCenterSpouseResultIds:[];
  const spouseCelebration=state.lotteries.filter(x=>isStore(x)&&isCelebration(x)&&isSpouse(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
  const pendingCelebration=spouseCelebration.filter(x=>['応募済','応募済み'].includes(String(x.status||'')));
  if(state.automation.pokemonCenterSpouseResultIds.includes(requestId)){
   if(spouseCelebration.length!==1)throw new Error('嫁分CELEBRATION BOXを一意に再確認できません');
   const spouseFuturistic=state.lotteries.filter(x=>isStore(x)&&isFuturistic(x)&&isSpouse(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
   if(spouseFuturistic.length!==1)throw new Error('嫁分FUTURISTIC BOXを一意に再確認できません');
   return{duplicate:true,changed:false,celebrationId:spouseCelebration[0].id,futuristicId:spouseFuturistic[0].id};
  }
  if(pendingCelebration.length!==1)throw new Error('応募済みの嫁分CELEBRATION BOXを一意に特定できません: '+pendingCelebration.length+'件');
  const celebration=pendingCelebration[0];
  if(String(celebration.resultDate||'')&&String(celebration.resultDate).slice(0,10)!==resultDate)throw new Error('嫁分CELEBRATION BOXの結果日が想定と一致しません');
  const now=new Date().toISOString();
  celebration.title=celebrationTitle;
  celebration.store=store;
  celebration.status='落選';
  celebration.resultDate=resultDate;
  celebration.receiptStatus='対象外';
  celebration.receivedDate='';
  celebration.owner=ownerTag;
  celebration.memo=appendMemo(celebration.memo,[ownerTag,'9/30 落選確認','ポケモンセンターオンライン']);
  celebration.updatedAt=now;

  let futuristicMatches=state.lotteries.filter(x=>isStore(x)&&isFuturistic(x)&&isSpouse(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
  if(futuristicMatches.length>1)throw new Error('嫁分FUTURISTIC BOXが重複しています: '+futuristicMatches.length+'件');
  let futuristic=futuristicMatches[0];
  if(futuristic){
   if(futuristic.status==='購入済'||futuristic.receiptStatus==='受取済み')throw new Error('嫁分FUTURISTIC BOXが購入済み/受取済みのため上書きを停止しました');
  }else{
   const id='lottery-pokemoncenter-wife-futuristic-20260930';
   if(state.lotteries.some(x=>String(x.id||'')===id))throw new Error('FUTURISTIC BOX用IDが既に使用されています');
   futuristic={id,title:futuristicTitle,store,status:'当選',resultDate,receiveDeadline:'2026-10-06',receiptStatus:'未受取',receivedDate:'',owner:ownerTag,memo:'',source:'chat',requestId,createdAt:now,updatedAt:now};
   state.lotteries.push(futuristic);
  }
  futuristic.title=futuristicTitle;
  futuristic.store=store;
  futuristic.status='当選';
  futuristic.resultDate=resultDate;
  futuristic.receiveDeadline='2026-10-06';
  if(futuristic.receiptStatus!=='受取済み')futuristic.receiptStatus='未受取';
  futuristic.receivedDate=futuristic.receivedDate||'';
  futuristic.owner=ownerTag;
  futuristic.memo=appendMemo(futuristic.memo,[ownerTag,'価格 27,500円','9/30 当選確認','注文 9/30 17:00〜10/6 16:59','お届け 2027/3/13〜3/31','商品コード 4521329463872']);
  futuristic.updatedAt=now;

  state.automation.pokemonCenterSpouseResultIds.push(requestId);
  state.automation.pokemonCenterSpouseResultIds=state.automation.pokemonCenterSpouseResultIds.slice(-100);
  return{duplicate:false,changed:true,celebrationId:celebration.id,futuristicId:futuristic.id};
 });
 const check=tv2Load_(),state=check.payload||{};
 const cMatches=(state.lotteries||[]).filter(x=>String(x.id||'')===String(result.celebrationId||''));
 const fMatches=(state.lotteries||[]).filter(x=>String(x.id||'')===String(result.futuristicId||''));
 if(cMatches.length!==1||cMatches[0].status!=='落選'||cMatches[0].title!==celebrationTitle||normalize_(cMatches[0].store)!==normalize_(store)||String(cMatches[0].owner||'')!==ownerTag)throw new Error('嫁分CELEBRATION BOXの再読込検証に失敗しました');
 if(fMatches.length!==1||fMatches[0].status!=='当選'||fMatches[0].title!==futuristicTitle||normalize_(fMatches[0].store)!==normalize_(store)||String(fMatches[0].owner||'')!==ownerTag)throw new Error('嫁分FUTURISTIC BOXの再読込検証に失敗しました');
 const spouseCelebrationFinal=(state.lotteries||[]).filter(x=>isStore(x)&&isCelebration(x)&&isSpouse(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
 const spouseFuturisticFinal=(state.lotteries||[]).filter(x=>isStore(x)&&isFuturistic(x)&&isSpouse(x)&&String(x.resultDate||'').slice(0,10)===resultDate);
 if(spouseCelebrationFinal.length!==1||spouseFuturisticFinal.length!==1)throw new Error('嫁分ポケモンセンター抽選の重複検証に失敗しました');
 return{ok:true,revision:Number(check.revision),celebration:{id:cMatches[0].id,title:cMatches[0].title,status:cMatches[0].status},futuristic:{id:fMatches[0].id,title:fMatches[0].title,status:fMatches[0].status,receiveDeadline:fMatches[0].receiveDeadline},mutationResult:result};
}

function runTv2ChatLotteryBulk(command){
 const input=command&&typeof command==='object'?command:{};
 const dates=Array.isArray(input.resultDates)?input.resultDates.map(x=>String(x||'').trim()).filter(Boolean):[];
 const status=String(input.status||'').trim(),requestId=String(input.requestId||'').trim();
 if(!dates.length||!requestId||!['当選','落選'].includes(status)||dates.some(d=>!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)))throw new Error('チャット抽選一括データが不正です');
 return tv2Mutate_('chat-lottery-bulk',state=>{
  state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};
  state.automation.chatLotteryBulkIds=Array.isArray(state.automation.chatLotteryBulkIds)?state.automation.chatLotteryBulkIds:[];
  if(state.automation.chatLotteryBulkIds.includes(requestId))return{duplicate:true,updated:0,changed:false};
  const targets=(state.lotteries||[]).filter(x=>dates.includes(String(x.resultDate||'').slice(0,10)));
  const blocked=targets.filter(x=>x.status==='購入済'||x.receiptStatus==='受取済み');
  if(blocked.length)throw new Error('購入済み/受取済みの抽選が含まれるため一括変更を停止しました: '+blocked.length+'件');
  let updated=0;const now=new Date().toISOString();
  targets.forEach(item=>{
   const old=JSON.stringify(item);
   item.status=status;
   if(status==='落選'){item.receiptStatus='対象外';item.receivedDate=''}
   else if(item.receiptStatus!=='受取済み')item.receiptStatus='未受取';
   item.updatedAt=now;
   if(JSON.stringify(item)!==old)updated++;
  });
  state.automation.chatLotteryBulkIds.push(requestId);
  state.automation.chatLotteryBulkIds=state.automation.chatLotteryBulkIds.slice(-200);
  return{duplicate:false,updated,matched:targets.length,changed:true};
 });
}


function runTv2RepairReceiptSale(command){
 const input=command&&typeof command==='object'?command:{};
 const requestId=String(input.requestId||'').trim(),baseId=String(input.basePurchaseId||'').trim(),saleId=String(input.saleId||'').trim();
 const targetUnitCost=Number(input.purchaseUnitCost),expectedSaleStore=String(input.expectedSaleStore||'').trim(),expectedSaleDate=String(input.expectedSaleDate||'').trim();
 const expectedPurchaseStore=String(input.expectedPurchaseStore||'').trim();
 if(!requestId||!baseId||!saleId||!Number.isFinite(targetUnitCost)||targetUnitCost<0||!expectedSaleStore||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(expectedSaleDate))throw new Error('受取・売却整合コマンドが不正です');
 const result=tv2Mutate_('repair-receipt-sale',state=>{
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  state.automation=state.automation&&typeof state.automation==='object'?state.automation:{};
  state.automation.repairReceiptSaleIds=Array.isArray(state.automation.repairReceiptSaleIds)?state.automation.repairReceiptSaleIds:[];
  if(state.automation.repairReceiptSaleIds.includes(requestId))return{duplicate:true,changed:false};

  const baseMatches=state.transactions.filter(t=>String(t.id||'')===baseId);
  if(baseMatches.length!==1||baseMatches[0].type!=='purchase')throw new Error('元購入履歴を一意に確認できません');
  const base=baseMatches[0],saleMatches=state.transactions.filter(t=>String(t.id||'')===saleId);
  if(saleMatches.length!==1||saleMatches[0].type!=='sale')throw new Error('対象売却を一意に確認できません');
  const sale=saleMatches[0],baseQty=Number(base.quantity||1);
  if(baseQty!==1||Number(sale.quantity||0)!==1)throw new Error('対象購入・売却の数量が1ではありません');
  if(String(sale.date||'')!==expectedSaleDate||normalize_(sale.store)!==normalize_(expectedSaleStore))throw new Error('対象売却の日付・店舗が想定と一致しません');
  if(expectedPurchaseStore&&!normalize_(base.store).includes(normalize_(expectedPurchaseStore)))throw new Error('元購入店舗が想定と一致しません');

  const oldUnit=Number(base.price??base.unitCost),oldTotal=oldUnit*baseQty,saleCost=Number(sale.acquisitionCost);
  if(!Number.isFinite(oldUnit)||oldUnit<0)throw new Error('元購入金額を確認できません');
  if(Number.isFinite(saleCost)&&saleCost!==oldTotal&&saleCost!==targetUnitCost)throw new Error('売却原価が元購入と一致しないため自動修正を停止しました');

  const baseKey=normalize_(base.productKey||base.product),purchaseStoreKey=normalize_(expectedPurchaseStore||base.store);
  const receiptTx=state.transactions.filter(t=>{
   if(t.type!=='purchase'||!String(t.id||'').startsWith('lottery-receipt-purchase-'))return false;
   if(normalize_(t.productKey||t.product)!==baseKey)return false;
   return !purchaseStoreKey||normalize_(t.store).includes(purchaseStoreKey)||purchaseStoreKey.includes(normalize_(t.store));
  });
  if(receiptTx.length>1)throw new Error('同じ受取購入履歴が複数あり、自動修正を停止しました');
  const receiptIds=new Set(receiptTx.map(t=>String(t.id||'')));
  const lotteryIds=new Set(receiptTx.map(t=>String(t.sourceLotteryId||'')).filter(Boolean));

  base.price=targetUnitCost;base.total=targetUnitCost*baseQty;
  if(Object.prototype.hasOwnProperty.call(base,'unitCost'))base.unitCost=targetUnitCost;
  const note='袋代等の付帯費用を除外して商品代のみへ補正';
  base.memo=String(base.memo||'').includes(note)?String(base.memo||''):[String(base.memo||''),note].filter(Boolean).join('｜');
  sale.acquisitionCost=targetUnitCost*baseQty;

  state.transactions=state.transactions.filter(t=>!receiptIds.has(String(t.id||'')));
  state.inventoryLots=state.inventoryLots.filter(l=>{
   const source=String(l.sourceTransactionId||'');
   return source!==baseId&&!receiptIds.has(source);
  });

  let lotteryCandidates=state.lotteries.filter(x=>lotteryIds.has(String(x.id||'')));
  if(!lotteryCandidates.length&&purchaseStoreKey){
   lotteryCandidates=state.lotteries.filter(x=>{
    const store=normalize_(x.receiptStore||x.store),product=normalize_(x.receiptProduct||x.title);
    return (store.includes(purchaseStoreKey)||purchaseStoreKey.includes(store))&&product===baseKey;
   });
  }
  if(lotteryCandidates.length>1)throw new Error('受取済み抽選を一意に確認できません');
  lotteryCandidates.forEach(item=>{
   item.status='購入済';item.receiptStatus='受取済み';item.receiptAmount=targetUnitCost*baseQty;item.receiptQuantity=baseQty;item.updatedAt=new Date().toISOString();
  });

  state.automation.repairReceiptSaleIds.push(requestId);
  state.automation.repairReceiptSaleIds=state.automation.repairReceiptSaleIds.slice(-100);
  return{duplicate:false,changed:true,oldUnitCost:oldUnit,newUnitCost:targetUnitCost,removedReceiptTransactionId:receiptTx[0]?String(receiptTx[0].id):'',updatedLotteryIds:lotteryCandidates.map(x=>x.id)};
 });

 const check=tv2Load_(),state=check.payload||{},base=state.transactions.filter(t=>String(t.id||'')===baseId),sale=state.transactions.filter(t=>String(t.id||'')===saleId);
 if(base.length!==1||Number(base[0].price)!==targetUnitCost)throw new Error('購入金額の再読込検証に失敗しました');
 if(sale.length!==1||Number(sale[0].acquisitionCost)!==targetUnitCost*Number(base[0].quantity||1))throw new Error('売却原価の再読込検証に失敗しました');
 const sourceLots=(state.inventoryLots||[]).filter(l=>String(l.sourceTransactionId||'')===baseId);
 if(sourceLots.length)throw new Error('売却済み購入元の在庫が残っています');
 const receiptDup=(state.transactions||[]).filter(t=>t.type==='purchase'&&String(t.id||'').startsWith('lottery-receipt-purchase-')&&normalize_(t.productKey||t.product)===normalize_(base[0].productKey||base[0].product)&&(!expectedPurchaseStore||normalize_(t.store).includes(normalize_(expectedPurchaseStore))));
 if(receiptDup.length)throw new Error('受取購入履歴の重複が残っています');
 const relatedLottery=(state.lotteries||[]).filter(x=>normalize_(x.receiptStore||x.store).includes(normalize_(expectedPurchaseStore))&&normalize_(x.receiptProduct||x.title)===normalize_(base[0].productKey||base[0].product));
 if(relatedLottery.length===1&&Number(relatedLottery[0].receiptAmount)!==targetUnitCost)throw new Error('受取金額の再読込検証に失敗しました');

 const summary={ok:true,revision:Number(check.revision),requestId,basePurchase:{id:base[0].id,product:base[0].product,store:base[0].store,date:base[0].date,quantity:base[0].quantity,price:base[0].price,total:base[0].total},sale:{id:sale[0].id,store:sale[0].store,date:sale[0].date,quantity:sale[0].quantity,price:sale[0].price,acquisitionCost:sale[0].acquisitionCost},sourceInventoryCount:sourceLots.length,receiptDuplicateCount:receiptDup.length,relatedLotteries:relatedLottery.map(x=>({id:x.id,status:x.status,receiptStatus:x.receiptStatus,receiptAmount:x.receiptAmount,receivedDate:x.receivedDate})),mutationResult:result};
 const resultSubject='[Toreca Vault Repair Result 20260927]';
 if(!GmailApp.getDrafts().some(d=>String(d.getMessage().getSubject()||'').trim()===resultSubject))GmailApp.createDraft(Session.getEffectiveUser().getEmail(),resultSubject,JSON.stringify(summary,null,2));
 return summary;
}

function tv2ProcessChatTradeDrafts_(){
 const subject='[Toreca Vault Command]';
 const drafts=GmailApp.getDrafts().filter(d=>String(d.getMessage().getSubject()||'').trim()===subject);
 const results=[];
 drafts.forEach(draft=>{
  try{
   const raw=String(draft.getMessage().getPlainBody()||'').trim();
   let command;try{command=JSON.parse(raw)}catch(e){throw new Error('Toreca Vaultコマンド下書きがJSONではありません')}
   const type=String(command&&command.type||'');
   if(!['sale','purchase','lottery','lottery-bulk','repair-receipt-sale','pokemoncenter-spouse-result'].includes(type))throw new Error('Toreca Vaultコマンド種別が不正です');
   const result=type==='sale'?runTv2ChatSale(command):type==='purchase'?runTv2ChatPurchase(command):type==='lottery'?runTv2ChatLottery(command):type==='lottery-bulk'?runTv2ChatLotteryBulk(command):type==='pokemoncenter-spouse-result'?runTv2PokemonCenterSpouseResult(command):runTv2RepairReceiptSale(command);
   draft.deleteDraft();
   results.push({ok:true,type,result});
  }catch(err){
   results.push({ok:false,error:String(err&&err.message||err)});
  }
 });
 return results;
}

function tv2HandleMarketRefreshWeb_(req){
 const body=req&&typeof req==='object'?req:{},action=String(body.action||'');
 const p=PropertiesService.getScriptProperties(),provided=String(body.token||''),accepted=['TV_SYNC_TOKEN','TV_V2_SYNC_TOKEN','TV2_SYNC_TOKEN'].map(k=>String(p.getProperty(k)||'')).filter(v=>v.length>=24);
 if(!accepted.length||!accepted.includes(provided))throw new Error('unauthorized');
 if(action!=='refresh-market-v2')throw new Error('unsupported action');
 const result=runTv2MarketAuto({skipQueue:true,skipScheduleEnsure:true});
 return ContentService.createTextOutput(JSON.stringify({ok:true,result})).setMimeType(ContentService.MimeType.JSON);
}


function tv2ProcessOneCommandByNonce_(requestId,nonce){
 requestId=String(requestId||'').trim();nonce=String(nonce||'').trim();
 if(!requestId||nonce.length<24)throw new Error('invalid one-time command key');
 const subject='[Toreca Vault Command]';
 const matches=GmailApp.getDrafts().filter(d=>{
  if(String(d.getMessage().getSubject()||'').trim()!==subject)return false;
  try{const cmd=JSON.parse(String(d.getMessage().getPlainBody()||'').trim());return String(cmd.requestId||'')===requestId&&String(cmd.oneTimeNonce||'')===nonce}catch(e){return false}
 });
 if(matches.length!==1)throw new Error('matching command draft not found');
 const draft=matches[0],command=JSON.parse(String(draft.getMessage().getPlainBody()||'').trim());
 if(String(command.type||'')!=='purchase')throw new Error('unsupported one-time command type');
 const result=runTv2ChatPurchase(command);
 const txId='chat-purchase-'+requestId,openingId='chat-opening-'+requestId,lotId=txId+'-lot';
 const loaded=tv2Load_(),state=loaded.payload||{};
 const tx=(state.transactions||[]).filter(t=>String(t.id||'')===txId),opening=(state.transactions||[]).filter(t=>String(t.id||'')===openingId),lot=(state.inventoryLots||[]).filter(l=>String(l.id||'')===lotId);
 const ok=tx.length===1&&opening.length===1&&lot.length===1&&String(lot[0].product||'')==='メガレックウザex'&&String(lot[0].set||'')==='M6 095/076'&&Number(lot[0].quantity)===1&&/SR/.test(String(lot[0].memo||''))&&normalize_(String(opening[0].product||'')).includes(normalize_('ストームエメラルダ'));
 if(!ok)throw new Error('V2 post-write verification failed');
 draft.deleteDraft();
 return{ok:true,revision:Number(loaded.revision),card:{product:lot[0].product,set:lot[0].set,quantity:lot[0].quantity,memo:lot[0].memo},opening:{product:opening[0].product,quantity:opening[0].quantity,date:opening[0].date},result};
}

function runTv2MegaRayquazaOnce20260927_(){
 const handler='runTv2MegaRayquazaOnce20260927_';
 try{
  const requestId='20260927-storm-emeralda-mega-rayquaza-ex-m6-095-076-sr',subject='[Toreca Vault Command]';
  const drafts=GmailApp.getDrafts().filter(d=>{
   if(String(d.getMessage().getSubject()||'').trim()!==subject)return false;
   try{return String(JSON.parse(String(d.getMessage().getPlainBody()||'').trim()).requestId||'')===requestId}catch(e){return false}
  });
  if(drafts.length>1)throw new Error('メガレックウザのコマンド下書きが複数あります');
  let result={duplicate:true,changed:false};
  if(drafts.length===1){
   const command=JSON.parse(String(drafts[0].getMessage().getPlainBody()||'').trim());
   result=runTv2ChatPurchase(command);
   drafts[0].deleteDraft();
  }
  const loaded=tv2Load_(),state=loaded.payload||{},txId='chat-purchase-'+requestId,openingId='chat-opening-'+requestId,lotId=txId+'-lot';
  const tx=(state.transactions||[]).filter(t=>String(t.id||'')===txId),opening=(state.transactions||[]).filter(t=>String(t.id||'')===openingId),lot=(state.inventoryLots||[]).filter(l=>String(l.id||'')===lotId);
  const ok=tx.length===1&&opening.length===1&&lot.length===1&&String(lot[0].product||'')==='メガレックウザex'&&String(lot[0].set||'')==='M6 095/076'&&Number(lot[0].quantity)===1&&/SR/.test(String(lot[0].memo||''))&&normalize_(String(opening[0].product||'')).includes(normalize_('ストームエメラルダ'));
  const summary={ok,revision:Number(loaded.revision),card:lot[0]?{product:lot[0].product,set:lot[0].set,quantity:lot[0].quantity,memo:lot[0].memo}:null,opening:opening[0]?{product:opening[0].product,quantity:opening[0].quantity,date:opening[0].date}:null,result};
  const to=Session.getEffectiveUser().getEmail();
  if(to){const resultSubject='[Toreca Vault Opening Result 20260927]';GmailApp.getDrafts().filter(d=>String(d.getMessage().getSubject()||'').trim()===resultSubject).forEach(d=>d.deleteDraft());GmailApp.createDraft(to,resultSubject,JSON.stringify(summary,null,2));}
  if(!ok)throw new Error('メガレックウザ開封獲得のV2再読込検証に失敗しました');
  return summary;
 }finally{
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===handler).forEach(t=>ScriptApp.deleteTrigger(t));
 }
}
function scheduleTv2MegaRayquazaOnce20260927(){
 const handler='runTv2MegaRayquazaOnce20260927_';
 ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===handler).forEach(t=>ScriptApp.deleteTrigger(t));
 ScriptApp.newTrigger(handler).timeBased().after(30000).create();
 return{scheduled:true,handler};
}

function tv2ProcessMegaRayquazaOnceWeb_(){
 return tv2ProcessOneCommandByNonce_(
  '20260927-storm-emeralda-mega-rayquaza-ex-m6-095-076-sr',
  'mr-20260927-5fa3c78b1e6249d8a6c1f047b39e52ad'
 );
}
