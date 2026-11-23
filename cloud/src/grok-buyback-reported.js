/**
 * Private owner-reported Grok buyback values for STAGING.
 * No prices, holdings, or report dates are hardcoded into this public repo.
 * Caller supplies the compact private price/stock inputs at execution time.
 * X original post evidence is not verified; all records remain "review".
 */
import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

const SOURCE='user-transcribed-grok-report';
const SHOPS=['買取ミミ','カードショップアリウム','AMTAF日本橋'];
const FAMILIES=['d','i','s','t','f','e'];
const N=s=>String(s||'').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000・_-]+/g,'');
const clone=x=>structuredClone(x);
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function block(msg){throw new Error('BLOCKED: '+msg);}
function productGroup(raw){
  const s=N(raw);
  if(/スタートデッキ100/.test(s)&&/バトルコレクション/.test(s)&&!/白箱|カートン|詰め合わせ/.test(s))return 's';
  if(/メガドリームex|megaドリームex|megadreamex/.test(s))return 'd';
  if(/インフェルノx/.test(s))return 'i';
  if(/スペシャルbox.*ポケモンセンター.*(?:トウホク|東北)/.test(s))return 't';
  if(/スペシャルbox.*ポケモンセンター.*(?:フクオカ|福岡)/.test(s))return 'f';
  if(/30thcelebration/.test(s)&&/プレミアムデッキセット/.test(s)
    &&/エーフィ/.test(s)&&/ブラッキー/.test(s))return 'e';
  return '';
}
function parsePairs(input,expr){
  const out=new Map();
  for(const row of String(input||'').split(';')){
    const match=row.match(expr);
    if(!match||out.has(match[1])||!FAMILIES.includes(match[1]))block('private report layout invalid');
    out.set(match[1],match.slice(2));
  }
  if(out.size!==FAMILIES.length||FAMILIES.some(k=>!out.has(k)))block('private report missing item');
  return out;
}
export function parsePrivateGrokInput({reportDate,stockSpec,priceSpec}={}){
  if(!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(reportDate||''))||
    new Date(reportDate+'T00:00:00+09:00').toString()==='Invalid Date')block('private report date invalid');
  const stock=parsePairs(stockSpec,/^([a-z])=([1-9]\d?)([au])$/);
  const prices=parsePairs(priceSpec,/^([a-z])=(\d{1,7}r?),(\d{1,7}r?),(\d{1,7}r?)$/);
  const items=new Map();let total=0;
  for(const family of FAMILIES){
    const [countRaw, conditionCode]=stock.get(family);
    const quantity=Number(countRaw);
    const offers=prices.get(family).map((entry,index)=>{
      const isReference=entry.endsWith('r');
      const price=Number(entry.replace(/r$/,''));
      if(!Number.isSafeInteger(price)||price<0||(isReference&&price===0))block('invalid private price');
      return price===0?null:{sourceStore:SHOPS[index],price,priceCaveat:isReference?'参考':''};
    }).filter(Boolean);
    if(!offers.length)block('all shops missing for '+family);
    const max=Math.max(...offers.map(x=>x.price));
    total+=max*quantity;
    items.set(family,{quantity,condition:conditionCode==='a'?'あり':'未開封',offers});
  }
  const mutationId='grok-report:'+reportDate+':'+createHash('sha256')
    .update(JSON.stringify({reportDate,stockSpec,priceSpec})).digest('hex').slice(0,20);
  return {reportDate,items,mutationId,priceTotalYen:total};
}
function conditionUpdate(original,target){
  const value=String(original||'');
  if(target==='あり'){
    if(['なし','シュリンクなし','対象外'].includes(value))block('shrink condition conflicts with owner report');
    return 'あり';
  }
  // 「対象外」 is a legacy shrink applicability marker for non-booster
  // sealed products, not evidence that the product has been opened.
  // The owner explicitly attested these selected products are unopened.
  // Restrict this normalization to the caller's explicit "u" stock spec;
  // shrink-required items above still fail closed on 「対象外」.
  return ['あり','なし','シュリンクなし'].includes(value)?value:'未開封';
}
export function previewGrokReportedPrices(snapshot,privateInput){
  validateState(snapshot);
  const parsed=parsePrivateGrokInput(privateInput);
  if(snapshot.auditLog.some(x=>x.mutationId===parsed.mutationId)){
    return {state:clone(snapshot),idempotent:true,changed:0,added:0,
      priceTotalYen:parsed.priceTotalYen,mutationId:parsed.mutationId};
  }
  const matches=new Map(FAMILIES.map(k=>[k,[]]));
  for(const lot of snapshot.inventoryLots){
    if(lot.category!=='BOX')continue;
    const group=productGroup(lot.product||lot.productKey);
    if(!group)continue;
    const alternate=productGroup(lot.productKey||lot.product);
    if(alternate&&alternate!==group)block('BOX name identity ambiguous');
    if(!Number.isSafeInteger(lot.quantity)||lot.quantity<=0)block('BOX quantity invalid');
    matches.get(group).push(lot);
  }
  for(const key of FAMILIES){
    const group=matches.get(key);
    const desired=parsed.items.get(key).quantity;
    if(!group.length||group.reduce((n,l)=>n+l.quantity,0)!==desired)block('BOX count differs: '+key);
  }
  const next=clone(snapshot);
  const targetIds=new Set([...matches.values()].flat().map(x=>x.id));
  let changed=0,added=0;
  for(const lot of next.inventoryLots){
    if(!targetIds.has(lot.id))continue;
    const item=parsed.items.get(productGroup(lot.product||lot.productKey));
    if(!item)block('target identity changed');
    const desired=conditionUpdate(lot.condition,item.condition);
    if(lot.condition!==desired){lot.condition=desired;changed++;}
    for(const quote of item.offers){
      next.marketQuotes.push({
        lotId:lot.id,productKey:String(lot.productKey||lot.product),category:'BOX',
        condition:lot.condition,unit:'box',price:quote.price,buybackYen:quote.price,
        sourceStore:quote.sourceStore,priceCaveat:quote.priceCaveat,
        source:'Grok（ユーザー提供・原投稿未検証）',priceBasis:'buyback',
        quoteBasis:SOURCE,reportId:parsed.mutationId,reportedDate:parsed.reportDate,
        postUrl:'',status:'review',fresh:false,evidenceVerified:false,
        quoteType:'owner-reported-provisional'
      });added++;
    }
  }
  for(let i=0;i<snapshot.inventoryLots.length;i++){
    const a={...snapshot.inventoryLots[i]},b={...next.inventoryLots[i]};
    delete a.condition;delete b.condition;
    if(!eq(a,b))block('inventory fields other than conditions changed');
  }
  for(const field of ['transactions','lotteries']){
    if(!eq(next[field],snapshot[field]))block(field+' changed');
  }
  next.revision=snapshot.revision+1;
  next.lastMutationId=parsed.mutationId;
  next.auditLog.push({mutationId:parsed.mutationId,kind:'grok-owner-reported-buyback-review',
    revision:next.revision,reportDate:parsed.reportDate,quoteCount:added,
    changedConditions:changed,evidenceVerified:false});
  validateState(next);
  return {state:next,idempotent:false,changed,added,
    priceTotalYen:parsed.priceTotalYen,mutationId:parsed.mutationId};
}
export function grokReportedOffersForLot(quotes,lot,now=new Date()){
  if(!(now instanceof Date)||Number.isNaN(now.getTime()))return [];
  const rows=(Array.isArray(quotes)?quotes:[]).filter(q=>{
    if(q.quoteBasis!==SOURCE||q.status!=='review'||q.evidenceVerified!==false||
      q.postUrl!==''||q.lotId!==lot.id||q.category!=='BOX'||q.condition!==lot.condition||
      !Number.isSafeInteger(q.price)||q.price<=0)return false;
    const posted=Date.parse(String(q.reportedDate||'')+'T00:00:00+09:00');
    return Number.isFinite(posted)&&posted<=now.getTime()&&now.getTime()-posted<=7*24*3600000;
  });
  if(!rows.length)return [];
  const mostRecent=rows.map(q=>q.reportedDate).sort().at(-1);
  return rows.filter(q=>q.reportedDate===mostRecent);
}
