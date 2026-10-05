// Fixed MSRP accounting for all non-single purchases; actual paid amount is retained separately.
const TV2_RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v1';
const TV2_RETAIL_PRICE_CATALOG=[
 {category:'BOX',test:/30th celebration.*カードセット.*9種|カードセット.*9種/i,price:10800,source:'ポケモンカード公式 30周年商品（9種セット）'},
 {category:'BOX',test:/30th celebration.*futuristic box|futuristic box/i,price:27500,source:'ポケモンカード公式 30周年商品'},
 {category:'BOX',test:/30th celebration.*プレミアムデッキセット|プレミアムデッキセット.*エーフィ.*ブラッキー/i,price:6200,source:'ポケモンカード公式 30周年商品'},
 {category:'BOX',test:/30th celebration.*カードセット/i,price:1200,source:'ポケモンカード公式 30周年商品'},
 {category:'BOX',test:/30th celebration/i,price:7200,source:'ポケモンカード公式 30周年商品'},
 {category:'パック',test:/30th celebration/i,price:360,source:'ポケモンカード公式 30周年商品'},
 {category:'BOX',test:/ストームエメラルダ/,price:6000,source:'ポケモンカード公式（1パック200円×30パック）'},
 {category:'パック',test:/ストームエメラルダ/,price:200,source:'ポケモンカード公式'},
 {category:'BOX',test:/インフェルノx/i,price:5400,source:'ポケモンカード公式（1パック180円×30パック）'},
 {category:'パック',test:/インフェルノx/i,price:180,source:'ポケモンカード公式'},
 {category:'BOX',test:/brightness of hope/i,price:5760,source:'ドラゴンボール フュージョンワールド公式（1BOX 24パック）'},
 {category:'パック',test:/brightness of hope/i,price:240,source:'ドラゴンボール フュージョンワールド公式'}
];
function tv2RetailPriceInfo_(product,category){
 const c=String(category||'').trim(),n=String(product||'').normalize('NFKC').replace(/\s+/g,' ').trim();if(!n||c==='カード')return null;
 const hit=TV2_RETAIL_PRICE_CATALOG.find(x=>x.category===c&&x.test.test(n));return hit?{price:hit.price,source:hit.source,basis:'希望小売価格'}:null;
}
function tv2EnforceRetailPricePolicy_(){
 const result=tv2Mutate_('retail-price-policy',state=>{
  const health=tv2Health_(state),beforeVersion=String(health.retailPricePolicyVersion||''),beforeReview=JSON.stringify(health.retailPriceNeedsReview||[]),changes=[],review=new Set();
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];state.lotteries=Array.isArray(state.lotteries)?state.lotteries:[];
  for(const t of state.transactions){
   if(String(t.category||'')==='カード')continue;const info=tv2RetailPriceInfo_(t.productKey||t.product,t.category);if(!info){if(['purchase','sale','opening'].includes(String(t.type||'')))review.add(String(t.product||t.productKey||''));continue}
   const q=Math.max(1,Number(t.quantity)||1);
   if(t.type==='purchase'){
    const old=Number(t.price!==undefined?t.price:t.unitCost);if(Number.isFinite(old)&&old>=0&&old!==info.price&&t.actualPaid==null){t.actualPaid=old;t.actualPaidTotal=old*q}
    if(Number(t.price)!==info.price||Number(t.total)!==info.price*q||Number(t.unitCost)!==info.price)changes.push('purchase:'+String(t.id||t.product));
    t.price=info.price;t.total=info.price*q;t.unitCost=info.price;t.priceBasis='希望小売価格';t.retailPriceSource=info.source;
   }else if(t.type==='sale'||t.type==='opening'){
    const target=info.price*q;if(Number(t.acquisitionCost)!==target)changes.push(String(t.type)+':'+String(t.id||t.product));t.acquisitionCost=target;t.acquisitionCostBasis='希望小売価格';t.retailPriceSource=info.source;
   }
  }
  for(const l of state.inventoryLots){
   if(String(l.category||'')==='カード')continue;const info=tv2RetailPriceInfo_(l.productKey||l.product,l.category);if(!info){review.add(String(l.product||l.productKey||''));continue}
   if(Number(l.unitCost)!==info.price)changes.push('lot:'+String(l.id||l.product));l.unitCost=info.price;l.priceBasis='希望小売価格';l.retailPriceSource=info.source;
  }
  for(const item of state.lotteries){
   const category=String(item.receiptCategory||'').trim();if(!category||category==='カード')continue;const info=tv2RetailPriceInfo_(item.receiptProduct||item.title,category);if(!info)continue;
   const q=Math.max(1,Number(item.receiptQuantity)||1),target=info.price*q,old=Number(item.receiptAmount);
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
