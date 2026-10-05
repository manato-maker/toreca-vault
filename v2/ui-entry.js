import{retailPriceInfo}from'./retail-price.js';
export const uiTypeToV2=type=>({purchases:'purchase',sales:'sale',openings:'opening'}[type]||null);
export function canUseV2Entry(type){return Boolean(uiTypeToV2(type))}
export function v2EntryPayload(type,data){
 const txType=uiTypeToV2(type);if(!txType)throw new Error('この入力はV2取引保存の対象外です');
 const out={...data,type:txType};
 if(out.category==='その他')throw new Error('V2では在庫カテゴリをBOX・パック・カードから選んでください');
 if(type==='purchases'&&data.inventoryAction==='記録のみ')throw new Error('V2では購入の「記録のみ」はまだ利用できません');
 if(type==='sales'&&data.inventoryAction==='記録のみ')throw new Error('V2では売却の「記録のみ」はまだ利用できません');
 const condition=String(data.condition||data.shrinkStatus||'').trim();if(['purchases','sales','openings'].includes(type)&&(!condition||condition==='未選択'))throw new Error('V2では在庫状態を選択してください');out.condition=condition;if(type==='openings')out.category='BOX';
 if(type==='purchases'&&out.category!=='カード'){
  const retail=retailPriceInfo(out.product,out.category);if(!retail)throw new Error('定価未登録の商品です。公式価格を確認して定価マスターへ追加してください');
  const entered=Number(data.price??data.unitCost),quantity=Number(out.quantity)||1;
  if(Number.isFinite(entered)&&entered>=0&&entered!==retail.price){out.actualPaid=entered;out.actualPaidTotal=entered*quantity}
  out.price=retail.price;out.unitCost=retail.price;out.total=retail.price*quantity;out.priceBasis='希望小売価格';out.retailPriceSource=retail.source;
 }
 return out;
}
