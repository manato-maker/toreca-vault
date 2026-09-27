function runTv2OpeningAcquireStormEmeralda20260927(){
 const requestId='20260927-storm-emeralda-mega-rayquaza-ex-sr';
 const openingId='chat-opening-'+requestId;
 const cardTxId='chat-opening-card-'+requestId;
 const cardLotId=cardTxId+'-lot';
 const targetName='ストームエメラルダ';
 const cardName='メガレックウザex';
 const cardSet='M6 095/076';
 const result=tv2Mutate_('chat-opening-acquire',state=>{
  state.transactions=Array.isArray(state.transactions)?state.transactions:[];
  state.inventoryLots=Array.isArray(state.inventoryLots)?state.inventoryLots:[];
  const existingOpening=state.transactions.filter(t=>String(t.id||'')===openingId);
  const existingCard=state.transactions.filter(t=>String(t.id||'')===cardTxId);
  const existingLot=state.inventoryLots.filter(l=>String(l.id||'')===cardLotId);
  if(existingOpening.length===1&&existingCard.length===1&&existingLot.length===1)return{duplicate:true,changed:false};
  if(existingOpening.length||existingCard.length||existingLot.length)throw new Error('開封獲得データが部分重複しています');

  const wanted=normalize_(targetName);
  const matches=state.inventoryLots.filter(l=>{
   if(l.category!=='BOX'||Number(l.quantity)<=0)return false;
   const name=normalize_(l.productKey||l.product);
   return name===wanted||name.includes(wanted)||wanted.includes(name);
  });
  if(!matches.length)throw new Error('ストームエメラルダのBOX在庫が見つかりません');
  const products=[...new Set(matches.map(l=>normalize_(l.productKey||l.product)))];
  const conditions=[...new Set(matches.map(l=>String(l.condition||'')))];
  if(products.length!==1||conditions.length!==1)throw new Error('開封対象BOXを一意に特定できません');

  matches.sort((a,b)=>String(a.acquiredAt||'').localeCompare(String(b.acquiredAt||''))||String(a.id||'').localeCompare(String(b.id||'')));
  const sourceLot=matches[0],boxProduct=String(sourceLot.product||sourceLot.productKey||targetName);
  const sourceCost=sourceLot.unitCost===null||sourceLot.unitCost===undefined||sourceLot.unitCost===''?null:Number(sourceLot.unitCost);
  sourceLot.quantity=Number(sourceLot.quantity)-1;
  state.inventoryLots=state.inventoryLots.filter(l=>Number(l.quantity)>0);

  state.transactions.push({
   id:openingId,type:'opening',product:boxProduct,productKey:boxProduct,category:'BOX',
   condition:String(sourceLot.condition||''),quantity:1,price:0,date:'2026-09-27',
   source:'chat',memo:'BOX開封',requestId,acquisitionCost:Number.isFinite(sourceCost)?sourceCost:null
  });
  state.transactions.push({
   id:cardTxId,type:'purchase',product:cardName,productKey:cardName,category:'カード',
   condition:'',set:cardSet,quantity:1,price:0,total:0,date:'2026-09-27',
   source:'opening',memo:'開封獲得｜SR｜'+boxProduct+' 1BOX開封',requestId
  });
  state.inventoryLots.push({
   id:cardLotId,product:cardName,productKey:cardName,category:'カード',
   condition:'',set:cardSet,quantity:1,unitCost:0,acquiredAt:'2026-09-27',
   sourceTransactionId:cardTxId,source:'opening',memo:'開封獲得｜SR｜'+boxProduct+' 1BOX開封',requestId
  });
  return{duplicate:false,changed:true,boxProduct,openingId,cardTxId,cardLotId};
 });

 const check=tv2Load_(),state=check.payload||{};
 const opening=state.transactions.filter(t=>String(t.id||'')===openingId);
 const cardTx=state.transactions.filter(t=>String(t.id||'')===cardTxId);
 const cardLot=state.inventoryLots.filter(l=>String(l.id||'')===cardLotId);
 const remaining=state.inventoryLots.filter(l=>{
  const name=normalize_(l.productKey||l.product);
  return l.category==='BOX'&&Number(l.quantity)>0&&(name===normalize_(targetName)||name.includes(normalize_(targetName))||normalize_(targetName).includes(name));
 }).reduce((n,l)=>n+Number(l.quantity||0),0);
 if(opening.length!==1||cardTx.length!==1||cardLot.length!==1||cardLot[0].set!==cardSet)throw new Error('開封獲得の再読込検証に失敗しました');

 const summary={
  ok:true,revision:Number(check.revision),boxOpened:{product:opening[0].product,quantity:1,remaining},
  acquiredCard:{product:cardLot[0].product,set:cardLot[0].set,quantity:cardLot[0].quantity,memo:cardLot[0].memo},
  mutationResult:result
 };
 const to=Session.getEffectiveUser().getEmail();
 if(to)GmailApp.createDraft(to,'[Toreca Vault Opening Result 20260927]',JSON.stringify(summary,null,2));
 return summary;
}
