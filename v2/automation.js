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
 for(const k of ['id','applicationId','entryNo','orderNo','livePocketId','store','product','appliedAt','status','result','source','receivedAt']){
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
