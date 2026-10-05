// Fixed MSRP accounting for all non-single purchases; actual paid amount is retained separately.
// v2 expands official-price coverage for legacy sealed-product names and bundles.
const TV2_RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v2';
const TV2_RETAIL_PRICE_CATALOG=[
 {test:/30th celebration.*カードセット.*9種|カードセット.*9種/i,fixed:10800,source:'ポケモンカード公式 30周年商品（9種セット）'},
 {test:/30th celebration.*futuristic box|futuristic box/i,fixed:27500,source:'ポケモンカード公式 30周年商品'},
 {test:/30th celebration.*プレミアムデッキセット|プレミアムデッキセット.*エーフィ.*ブラッキー/i,fixed:6200,source:'ポケモンカード公式 商品情報'},
 {test:/30th celebration.*カードセット/i,fixed:1200,source:'ポケモンカード公式 30周年商品'},
 {test:/スペシャルbox ポケモンセンター(?:トウホク|フクオカ|ヒロシマ)/i,fixed:2090,source:'ポケモンカード公式 商品情報'},
 {test:/スタートデッキ100.*バトルコレクション|mega スタートデッキ100/i,fixed:891,source:'ポケモンカード公式 商品情報'},
 {test:/マクドナルド.*プロモカードパック/i,fixed:0,source:'非売品プロモ（購入原価0円）'},
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
function tv2EnforceRetailPricePolicy_(){
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
 if(result&&result.changed&&!result.unchanged){
  const subject='[Toreca Vault MSRP Policy Result] '+TV2_RETAIL_PRICE_POLICY_VERSION,to=Session.getEffectiveUser().getEmail();
  GmailApp.getDrafts().filter(d=>String(d.getMessage().getSubject()||'').trim()===subject).forEach(d=>d.deleteDraft());
  if(to)GmailApp.createDraft(to,subject,JSON.stringify(result,null,2));
 }
 return result;
}
