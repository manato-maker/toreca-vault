/**
 * Provisional card BUYBACK values confirmed by owner from chat research.
 * Prices, holdings and identities are runtime-only, NEVER public source.
 * This is a dated, unverified reference market feed, not a verified quote.
 */
import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

const SOURCE='owner-chat-researched-single-buyback-v1';
const SHOP_LABELS={f:'フルコンプ（チャット調査報告）',k:'カードラッシュ参照・二次掲載（チャット調査報告）',n:'ナタデココ（チャット調査報告）'};
const clone=structuredClone;
const equality=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function blocked(reason){throw new Error('BLOCKED: '+reason);}
const norm=x=>String(x||'').normalize('NFKC').toUpperCase().replace(/[\s\u3000]+/g,' ').trim();
function dateToEpoch(date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return NaN;
  const millis=Date.parse(date+'T00:00:00+09:00');
  return Number.isFinite(millis)&&new Date(millis+9*3600000).toISOString().slice(0,10)===date?millis:NaN;
}
function exactIdentity(text) {
  const v=norm(text);
  const m=/\b([A-Z0-9]{1,14})\s+(\d{1,4}\/(?:\d{1,4}|[A-Z0-9]{1,8}-P))\b/.exec(v);
  return m?m[1]+' '+m[2]:'';
}
export function parseOwnerSinglePrices({priceSpec,reportDate,expectedLots,expectedCards}={}){
  if(!Number.isSafeInteger(expectedLots)||expectedLots<1||expectedLots>100 ||
    !Number.isSafeInteger(expectedCards)||expectedCards<expectedLots||expectedCards>500 ||
    !Number.isFinite(dateToEpoch(String(reportDate||''))))blocked('report date or expected stock counts invalid');
  const rows=String(priceSpec||'').split(';');
  if(rows.length<1||rows.length>100)blocked('price batch invalid');
  const items=new Map();
  for(const row of rows) {
    const m=/^([A-Za-z0-9]{1,14})_([0-9]{1,4}\/(?:[0-9]{1,4}|[A-Za-z0-9]{1,8}-[Pp]))=([1-9]\d{0,2}),([1-9]\d{0,7}),(\d{8}),([fkn])$/i.exec(row);
    if(!m)blocked('price row syntax invalid');
    const identity=norm(m[1]+' '+m[2]);
    const expectedQty=Number(m[3]),price=Number(m[4]);
    const date=m[5].slice(0,4)+'-'+m[5].slice(4,6)+'-'+m[5].slice(6,8);
    const dateMs=dateToEpoch(date);
    const reportMs=dateToEpoch(reportDate);
    if(!Number.isFinite(dateMs)||dateMs>reportMs||reportMs-dateMs>7*86400000 ||
      !Number.isSafeInteger(price)||price<=0||items.has(identity))blocked('duplicate, future, expired or invalid reported price');
    items.set(identity,{identity,expectedQty,price,reportedDate:date,sourceCode:m[6].toLowerCase()});
  }
  const id='chat-singles-report:'+reportDate+':'+createHash('sha256')
    .update(JSON.stringify({priceSpec,reportDate,expectedLots,expectedCards})).digest('hex').slice(0,24);
  return {items,mutationId:id,reportDate,expectedLots,expectedCards};
}
export function previewOwnerSinglePrices(snapshot,privateInput){
  validateState(snapshot);
  const parsed=parseOwnerSinglePrices(privateInput);
  if(snapshot.auditLog.some(x=>x.mutationId===parsed.mutationId)){
    return {state:clone(snapshot),alreadyApplied:true,changed:0,pricedCards:0,unpricedCards:0,
      mutationId:parsed.mutationId,reportedTotalYen:0};
  }
  const all=snapshot.inventoryLots.filter(l=>l.category==='カード'&&Number.isSafeInteger(l.quantity)&&l.quantity>0);
  if(all.length!==parsed.expectedLots||all.reduce((s,l)=>s+l.quantity,0)!==parsed.expectedCards)
    blocked('canonical card inventory counts changed since reported export');
  const lookup=new Map();
  for(const lot of all){
    // setCardIdentity() writes to lot.set; some older lots have it on the purchase.
    const source=snapshot.transactions.find(t=>t.id===lot.sourceTransactionId&&t.type==='purchase');
    const stored=exactIdentity(lot.set||source?.set);
    if(!stored)continue;
    if(lookup.has(stored))blocked('two card lots share one set identity; do not guess');
    lookup.set(stored,lot);
  }
  const next=clone(snapshot);
  let pricedCards=0,reportedTotalYen=0,added=0;
  for(const [identity,item] of parsed.items){
    const original=lookup.get(identity);
    if(!original)blocked('card number is absent from canonical; do not guess matching variant');
    if(original.identityNeedsReview===true)blocked('card is flagged for identity review');
    if(original.quantity!==item.expectedQty)blocked('card quantity differs from reported quantity');
    if(!Number.isSafeInteger(original.quantity)||original.quantity<1)blocked('invalid card quantity');
    const lot=next.inventoryLots.find(x=>x.id===original.id);
    if(!lot||lot.category!=='カード')blocked('matched card lot disappeared');
    next.marketQuotes.push({
      lotId:lot.id,productKey:String(lot.productKey||lot.product),
      cardIdentity:identity,category:'カード',condition:String(lot.condition||''),
      unit:'card',price:item.price,buybackYen:item.price,
      sourceStore:SHOP_LABELS[item.sourceCode],source:'Chat調査結果（元掲載未検証）',
      priceBasis:'buyback',quoteBasis:SOURCE,reportId:parsed.mutationId,
      reportedDate:item.reportedDate,reportDate:parsed.reportDate,
      postUrl:'',status:'review',fresh:false,evidenceVerified:false,
      quoteType:'owner-approved-unverified-card-reference'
    });
    pricedCards+=lot.quantity;
    reportedTotalYen+=item.price*lot.quantity;
    added++;
  }
  next.revision=snapshot.revision+1;
  next.lastMutationId=parsed.mutationId;
  next.auditLog.push({mutationId:parsed.mutationId,kind:'owner-chat-single-card-reference-import',
    revision:next.revision,reportDate:parsed.reportDate,pricedLotCount:added,
    pricedCardCount:pricedCards,unpricedCardCount:parsed.expectedCards-pricedCards,
    evidenceVerified:false});
  validateState(next);
  for(const field of ['inventoryLots','transactions','lotteries']){
    if(!equality(next[field],snapshot[field]))blocked('non-market canonical data changed');
  }
  return {state:next,alreadyApplied:false,changed:added,pricedCards,
    unpricedCards:parsed.expectedCards-pricedCards,reportedTotalYen,mutationId:parsed.mutationId};
}
export function ownerSingleReportedOffersForLot(quotes,lot,now=new Date()){
  if(lot?.category!=='カード'||!Array.isArray(quotes)||
    !(now instanceof Date)||Number.isNaN(now.getTime()))return [];
  const matching=quotes.filter(q=>{
    if(q.quoteBasis!==SOURCE||q.status!=='review'||q.evidenceVerified!==false||
      q.postUrl!==''||q.lotId!==lot.id||q.category!=='カード'||
      String(q.condition||'')!==String(lot.condition||'')||
      String(q.productKey||'')!==String(lot.productKey||lot.product||'')||
      !Number.isSafeInteger(q.price)||q.price<=0)return false;
    const posted=dateToEpoch(String(q.reportedDate||''));
    return Number.isFinite(posted)&&now.getTime()>=posted&&now.getTime()-posted<=7*86400000;
  });
  if(!matching.length)return [];
  matching.sort((a,b)=>String(b.reportedDate).localeCompare(String(a.reportedDate)));
  return matching.filter(q=>q.reportedDate===matching[0].reportedDate);
}
