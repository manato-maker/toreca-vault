import{inventoryKey}from'./core.js';
const clone=x=>structuredClone(x);
const norm=x=>String(x||'').trim().toLocaleLowerCase('ja');
export function lotteryApplicationKey(x){return norm(x.applicationId||x.entryNo||x.orderNo||x.livePocketId||'')}
export function matchLottery(lotteries,input){
 const key=lotteryApplicationKey(input);if(key){const hits=lotteries.filter(x=>lotteryApplicationKey(x)===key);if(hits.length===1)return{kind:'match',record:hits[0]};if(hits.length>1)return{kind:'duplicate',records:hits}}
 const candidates=lotteries.filter(x=>norm(x.store)===norm(input.store)&&norm(x.product)===norm(input.product)&&(!input.appliedAt||!x.appliedAt||String(x.appliedAt)===String(input.appliedAt)));
 if(candidates.length===1)return{kind:'match',record:candidates[0]};if(candidates.length>1)return{kind:'review',records:candidates};return{kind:'new'};
}
export function mergeLotteryMail(state,input){const next=clone(state);if(!input)return{state:next,outcome:'review'};const stableMailId=String(input.id||'').trim();const applicationKey=lotteryApplicationKey(input);if(!stableMailId&&!applicationKey)return{state:next,outcome:'review'};const m=matchLottery(next.lotteries,input);if(m.kind==='duplicate')return{state:next,outcome:'duplicate'};if(m.kind==='review')return{state:next,outcome:'review'};if(m.kind==='match'){const i=next.lotteries.findIndex(x=>x.id===m.record.id);next.lotteries[i]={...next.lotteries[i],...clone(input),id:m.record.id};return{state:next,outcome:'updated'}};next.lotteries.push(clone(input));return{state:next,outcome:'created'}}
export function applyMarketFetch(state,target,result){const next=clone(state),k=inventoryKey(target),i=next.marketQuotes.findIndex(x=>inventoryKey(x)===k);if(!result||result.ok!==true||!(Number(result.price)>=0))return{state:next,outcome:'preserved'};const quote={product:target.product,productKey:target.productKey,category:target.category,condition:target.condition,price:Number(result.price),checkedAt:result.checkedAt||'',source:result.source||'',history:i>=0?[...(next.marketQuotes[i].history||[]),{price:Number(result.price),checkedAt:result.checkedAt||'',source:result.source||''}]:[{price:Number(result.price),checkedAt:result.checkedAt||'',source:result.source||''}]};if(i>=0)next.marketQuotes[i]=quote;else next.marketQuotes.push(quote);return{state:next,outcome:'updated'}}
export function recordAutomationHealth(state,name,result){const next=clone(state);next.automation=next.automation||{};next.automation.health=next.automation.health||{};next.automation.health[name]={lastRunAt:result.at||'',lastSuccessAt:result.ok?(result.at||''):(next.automation.health[name]?.lastSuccessAt||''),lastFailureAt:result.ok?(next.automation.health[name]?.lastFailureAt||''):(result.at||''),ok:!!result.ok,externalFetchCount:Number(result.externalFetchCount)||0,error:result.error||''};return next}

export function runMarketBatch(state,targets,fetchQuote,at=''){let next=clone(state),externalFetchCount=0,updated=0,preserved=0;for(const target of targets){let result;try{externalFetchCount++;result=fetchQuote(target)}catch(err){result={ok:false,error:String(err&&err.message||err)}}const applied=applyMarketFetch(next,target,result);next=applied.state;if(applied.outcome==='updated')updated++;else preserved++}next=recordAutomationHealth(next,'market',{ok:preserved===0,at,externalFetchCount,error:preserved?preserved+' fetch(es) preserved prior quote':''});return{state:next,updated,preserved,externalFetchCount}}
export function runLotteryBatch(state,inputs,at=''){if(!Array.isArray(inputs))throw new Error('lottery inputs must be an array');let next=clone(state),created=0,updated=0,duplicate=0,review=0;for(const input of inputs){const r=mergeLotteryMail(next,input);next=r.state;if(r.outcome==='created')created++;else if(r.outcome==='updated')updated++;else if(r.outcome==='duplicate')duplicate++;else review++}next=recordAutomationHealth(next,'lottery',{ok:review===0,at,externalFetchCount:inputs.length,error:review?review+' item(s) require review':''});return{state:next,created,updated,duplicate,review}}


export function normalizeLotteryMail(input){
 const x=input||{},stableMailId=String(x.id||'').trim(),applicationKey=lotteryApplicationKey(x);
 if(!stableMailId&&!applicationKey)return{ok:false,review:true,reason:'missing-stable-id'};
 const out={};
 for(const k of ['id','applicationId','entryNo','orderNo','livePocketId','store','product','tcg','appliedAt','status','result','source','receivedAt']){
  if(x[k]!==undefined&&x[k]!==null&&String(x[k]).trim()!=='')out[k]=typeof x[k]==='string'?x[k].trim():x[k];
 }
 if(!out.store||!out.product)return{ok:false,review:true,reason:'missing-store-or-product',input:out};
 return{ok:true,review:false,input:out};
}
export function prepareLotteryMailBatch(rawInputs){
 if(!Array.isArray(rawInputs))throw new Error('lottery mail inputs must be an array');
 const accepted=[],review=[];
 for(const raw of rawInputs){const r=normalizeLotteryMail(raw);if(r.ok)accepted.push(r.input);else review.push({reason:r.reason,input:r.input||raw||{}})}
 return{accepted,review};
}


export function parseLivePocketLotteryMail(mail){
 const id=String(mail?.id||'').trim(),subject=String(mail?.subject||''),body=String(mail?.body||''),receivedAt=String(mail?.receivedAt||mail?.email_ts||'');
 if(!id||!body||subject.indexOf('[LivePocket]')<0)return{ok:false,review:true,reason:'not-livepocket-or-missing-id'};
 const applicationId=(subject.match(/[（(](\d{6,})[）)]/)||body.match(/申込番号[：:]\s*(\d{6,})/))?.[1]||'';
 const event=(body.match(/イベント名[：:]\s*([^\n]+)/)||[])[1]?.trim()||'';
 const venue=(body.match(/会場[：:]\s*([^\n]+)/)||[])[1]?.trim()||'';
 if(!applicationId||!event||!venue)return{ok:false,review:true,reason:'livepocket-fields-missing'};
 let status='応募済み';
 if(/落選となりました/.test(body))status='落選';
 else if(/当選となりました|当選いたしました|ご当選/.test(body))status='当選';
 else if(!/申込みが完了しました/.test(body))return{ok:false,review:true,reason:'livepocket-status-unknown'};
 return normalizeLotteryMail({id,applicationId,livePocketId:applicationId,store:venue,product:event,tcg:classifyTradingCardLottery(event),status,source:'LivePocket',receivedAt});
}


export function classifyTradingCardLottery(event){
 const x=String(event||'');
 if(/ポケモン|ポケカ|Pokémon|Pokemon/i.test(x))return'pokemon';
 if(/ワンピース|ONE\s*PIECE/i.test(x))return'one-piece';
 if(/ドラゴンボール|DRAGON\s*BALL/i.test(x))return'dragon-ball';
 if(/ユニオンアリーナ|UNION\s*ARENA/i.test(x))return'union-arena';
 if(/遊戯王|YU-?GI-?OH/i.test(x))return'yu-gi-oh';
 return'other-tcg';
}


export function prepareLotteryMailForMerge(mail){
 const parsed=parseLivePocketLotteryMail(mail);
 if(!parsed.ok)return{accepted:[],review:[{reason:parsed.reason,input:{id:String(mail?.id||''),subject:String(mail?.subject||'')}}]};
 return prepareLotteryMailBatch([parsed.input]);
}


export function parseToysRUsLotteryMail(mail){
 const id=String(mail?.id||'').trim(),subject=String(mail?.subject||''),body=String(mail?.body||''),receivedAt=String(mail?.receivedAt||mail?.email_ts||'');
 if(!id||!body||!/^申込受付完了/.test(subject)||!/日本トイザらス株式会社/.test(body))return{ok:false,review:true,reason:'not-toysrus-or-missing-id'};
 const product=(subject.match(/申込受付完了[『「]\s*([^』」]+)[』」]/)||body.match(/[『「]([^』」]+)[』」]の抽選受付が完了/))?.[1]?.trim()||'';
 const store=(body.match(/受取登録店舗は[「『]([^」』]+)[」』]/)||[])[1]?.trim()||'';
 if(!product||!store)return{ok:false,review:true,reason:'toysrus-fields-missing'};
 if(!/抽選受付が完了しました/.test(body))return{ok:false,review:true,reason:'toysrus-status-unknown'};
 return normalizeLotteryMail({id,store:'トイザらス '+store,product,tcg:classifyTradingCardLottery(product),status:'応募済み',source:'ToysRUs',receivedAt});
}
