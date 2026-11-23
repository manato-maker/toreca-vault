/**
 * Generic, explicitly scoped owner-corrected inventory cost, staging only.
 * Personal product names and cost figures are passed only at Cloud Shell
 * runtime and never committed to public source code.
 */
import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

const norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function blocked(s){throw new Error('BLOCKED: '+s);}
export function readCostCorrection(input={}){
  const productName=norm(input.productName), category=norm(input.category);
  const expectedCost=input.expectedCost, newCost=input.newCost;
  const expectedQuantity=input.expectedQuantity;
  if(!productName||productName.length>200||!['パック','BOX','カード'].includes(category)||
    !Number.isSafeInteger(expectedCost)||expectedCost<0||
    !Number.isSafeInteger(newCost)||newCost<0||
    !Number.isSafeInteger(expectedQuantity)||expectedQuantity<1)blocked('invalid private scoped cost parameters');
  if(expectedCost===newCost)blocked('original and target costs must differ');
  const mutationId='staging-lot-cost-'+createHash('sha256')
    .update(JSON.stringify([productName,category,expectedCost,newCost,expectedQuantity]))
    .digest('hex').slice(0,24);
  return {productName,category,expectedCost,newCost,expectedQuantity,mutationId};
}
export function previewScopedCostCorrection(original,privateInput){
  validateState(original);
  const input=readCostCorrection(privateInput);
  const matches=original.inventoryLots.filter(lot=>lot.category===input.category &&
    norm(lot.product||lot.productKey)===input.productName);
  if(matches.length!==1)blocked('exactly one matching scoped inventory lot required');
  const lot=matches[0];
  if(lot.quantity!==input.expectedQuantity)blocked('quantity does not match approved scope');
  if(lot.unitCost!==input.expectedCost&&lot.unitCost!==input.newCost)
    blocked('existing cost differs from approved old/new value');
  if(lot.unitCost===input.newCost)return {state:structuredClone(original),alreadyCorrect:true,mutationId:input.mutationId};
  const next=structuredClone(original),target=next.inventoryLots.find(x=>x.id===lot.id);
  if(!target||target.unitCost!==input.expectedCost)blocked('scoped inventory lot changed');
  target.unitCost=input.newCost;
  next.revision=original.revision+1;
  next.lastMutationId=input.mutationId;
  if(next.auditLog.some(x=>x.mutationId===input.mutationId))blocked('conflicting previous scoped cost mutation');
  next.auditLog.push({mutationId:input.mutationId,kind:'staging-scoped-cost-correction',
    revision:next.revision,oldUnitCost:input.expectedCost,newUnitCost:input.newCost});
  validateState(next);
  for(const field of ['transactions','lotteries','marketQuotes']){
    if(!eq(next[field],original[field]))blocked('unrelated '+field+' changed');
  }
  const originals=new Map(original.inventoryLots.map(l=>[l.id,l]));
  for(const row of next.inventoryLots){
    const before=originals.get(row.id);
    if(!before)blocked('inventory identity changed');
    const a={...row},b={...before};
    delete a.unitCost;delete b.unitCost;
    if(!eq(a,b)|| (row.id!==lot.id&&row.unitCost!==before.unitCost))
      blocked('unrelated inventory fields changed');
  }
  return {state:next,alreadyCorrect:false,mutationId:input.mutationId};
}
export function singleCardResearchList(canonical, observedAt=new Date()) {
  if(!canonical?.payload || canonical.payload.revision!==canonical.revision ||
    !(observedAt instanceof Date)||Number.isNaN(observedAt.getTime())) {
    blocked('canonical revision/date invalid');
  }
  validateState(canonical.payload);
  const lots=canonical.payload.inventoryLots.filter(lot=>lot.category==='カード'&&
    Number.isSafeInteger(lot.quantity)&&lot.quantity>0);
  const total=lots.reduce((sum,l)=>sum+l.quantity,0);
  const when=new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
    hour12:false
  }).format(observedAt);
  const lines=[
    '【Toreca Vault シングルカード買取価格調査用・ステージング在庫】',
    '抽出日時: '+when+' JST / 正本rev '+canonical.revision,
    '総数: '+lots.length+'ロット / '+total+'枚',
    '参考サイト: カードラッシュ（買取リスト）https://www.cardrush-pokemon.jp/page/40',
    '参考サイト: アルテマ（ポケカチ）https://altema.jp/pokemoncard/',
    '注意: サイトの販売価格は買取価格ではない。7日より古い価格は参考にも採用しない。',
    '一致条件: カード名、カード番号、収録弾、レアリティ、状態、買取価格、情報掲載日。',
    'lot.set（V2登録済みの識別情報）と購入記録のset欄も確認する。',
    'カード番号未登録や同名異版は価格を推測せず「要確認」とする。',
    'ポケモンカード以外の作品はアルテマ（ポケカチ）・カードラッシュ（ポケモン）の照合対象外。',
    '必要な出力: 行番号｜カード名｜買取価格｜出典サイト｜掲載日時｜カード固有ページURL｜照合済みカード番号',
    ''
  ];
  for(let i=0;i<lots.length;i++){
    const l=lots[i];
    const name=norm(l.product||l.productKey)||'名称未登録';
    // V2's setCardIdentity() stores the exact card identifier in lot.set,
    // e.g. "M6a 127/103" or "PROMO 001/SV-P". Older exporters
    // accidentally ignored it and misreported the card number as missing.
    const sourceTransaction=canonical.payload.transactions.find(t=>
      t.id===l.sourceTransactionId && t.type==='purchase');
    const storedSet=norm(l.set||sourceTransaction?.set||'');
    const fullIdentity=storedSet.match(/\b([A-Za-z0-9]{1,12})\s+(\d{1,4}\/\d{1,4}|\d{1,4}\/[A-Za-z0-9]{1,8}-P)\b/i);
    const fromName=name.match(/\b\d{1,4}\/(?:\d{1,4}|[A-Za-z0-9]{1,8}-P)\b/i)?.[0]||'';
    const fromStoredNumber=fullIdentity?.[2]||'';
    const explicitNumber=norm(l.cardNumber||l.cardNo||l.collectorNumber||'');
    const alternatives=[explicitNumber,fromStoredNumber,fromName].filter(Boolean);
    const identityConflict=new Set(alternatives.map(x=>x.toUpperCase())).size>1;
    const number=identityConflict?'番号要確認（識別情報不一致）':
      (alternatives[0]||'番号未記録');
    const rarity=norm(l.rarity||'')
      || name.match(/(?:^|[\s（(])(?:MUR|SAR|CSR|CHR|SR|UR|HR|AR|RR)(?=$|[\s）)])/i)?.[0]?.trim()
      || 'レアリティ未記録';
    const set=norm(l.setCode||l.expansion||'')||fullIdentity?.[1]||storedSet||'収録弾未記録';
    const condition=norm(l.condition||'')||'状態未記録';
    lines.push(String(i+1)+'. '+name+'｜'+l.quantity+'枚｜'+number+'｜'+set+'｜'+rarity+'｜'+condition);
  }
  lines.push('','※表示は在庫の読取専用スナップショット。ここに記載されたカードの価格を取得できたことを意味しない。');
  return {text:lines.join('\n')+'\n',lots:lots.length,quantity:total};
}
