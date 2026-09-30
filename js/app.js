import{assets,storeStats}from'./calculations.js';
import{id,emptyState}from'./schema.js';
import{applyPurchase,applySale,applyOpening}from'./inventory.js';
import{tryLoadV2ReadOnly,hasV2ReadOnly,applyV2ReadOnlyToUi,enableV2ReadOnly,disableV2ReadOnly}from'./v2-readonly.js?v=20260929-htmlfallback-v1';
import{requiresVaultV2,getVaultV2Config}from'../v2/browser-sync.js?v=20260927-permanent-v2';
import{acceptanceSnapshot,pendingMigrationSnapshot}from'../v2/acceptance.js?v=20260927-migration-check-v2';
import{commitV2Transaction,commitV2CardIdentity}from'../v2/ui-write.js?v=20260927-concurrent-verify-v1';
import{commitV2LotteryManualPatches,commitV2LotteryReceiptPurchase}from'../v2/lottery-write.js?v=20260927-concurrent-verify-v1';
import{isV2WriteEnabled,enableV2WriteForSession,advanceV2WriteRevision,disableV2Write}from'../v2/write-gate.js?v=20260927-persistent-v1';
import{canUseV2Entry,v2EntryPayload}from'../v2/ui-entry.js';

const jstToday=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const initialV2Config=getVaultV2Config();
let state=emptyState(),remoteRevision='',receiptTargetId='',v2ReadOnly=true,v2AssetsCache=null,v2ProfitCache=null,v2AutomationHealth={};const initialHash=location.hash.slice(1).split('/');let route=initialHash[0]||'dashboard';let subtype=route==='inventory'&&['boxes','packs','cards'].includes(initialHash[1])?initialHash[1]:route==='ledger'&&initialHash[1]?initialHash[1]:'purchases';let calendarMonth=jstToday().slice(0,7);let selectedCalendarDate=jstToday(),reviewExpanded=false,pendingExpanded=false;
const yen=new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0});
const dateFmt=new Intl.DateTimeFormat('ja-JP',{month:'short',day:'numeric',weekday:'short'});
const nav=[['dashboard','⌂','資産'],['calendar','□','予定'],['ledger','¥','収支'],['activity','↗','履歴']];
const titles={dashboard:'資産ダッシュボード',calendar:'予定カレンダー',lotteries:'予定管理',ledger:'月別収支',inventory:'在庫詳細',activity:'取引履歴',products:'商品マスター'};
const fields={
 lotteries:[['title','抽選名','text',1],['store','店舗','text'],['status','状態','select',['応募前','応募済','当選','落選','購入済']],['deadline','応募締切','datetime-local'],['resultDate','結果発表','date'],['receiveDeadline','購入期限','date'],['receivedDate','受取日','date'],['receiptStatus','受取状況','select',['対象外','未受取','受取済み']],['shrinkStatus','シュリンク','select',['未選択','シュリンクあり','シュリンクなし','対象外']],['memo','詳細・メモ','textarea',1]],
 purchases:[['date','購入日','date'],['store','店舗','text'],['product','商品名','text',1],['set','カードの収録・番号（カードのみ）','text',1],['quantity','数量','number'],['price','単価','number'],['category','種別','select',['BOX','パック','カード','その他']],['condition','在庫状態','select',['未選択','あり','なし','未開封','対象外','美品','良品','傷あり','鑑定品']],['inventoryAction','在庫連動','select',['在庫へ追加','記録のみ']],['memo','メモ','textarea',1]],
 sales:[['date','売却日','date'],['store','売却先','text'],['product','商品名','text',1],['quantity','数量','number'],['price','単価','number'],['fee','手数料','number'],['category','在庫種別','select',['BOX','パック','カード','その他']],['condition','在庫状態','select',['未選択','あり','なし','未開封','対象外','美品','良品','傷あり','鑑定品']],['inventoryAction','在庫連動','select',['在庫から減算','記録のみ']],['memo','メモ','textarea',1]],
 boxes:[['product','BOX名','text',1],['quantity','数量','number'],['cost','取得単価','number'],['marketPrice','推定価格','number'],['store','購入店','text'],['date','取得日','date'],['memo','メモ','textarea',1]],
 packs:[['product','パック名','text',1],['quantity','数量','number'],['cost','取得単価','number'],['marketPrice','推定価格','number'],['store','購入店','text'],['date','取得日','date'],['memo','メモ','textarea',1]],
 cards:[['product','カード名','text',1],['set','収録・型番','text',1],['quantity','数量','number'],['cost','取得単価','number'],['buybackPrice','買取価格','number'],['condition','状態','select',['美品','良品','傷あり','鑑定品']],['memo','メモ','textarea',1]],
 openings:[['date','開封日','date'],['product','開封するBOX名','text',1],['quantity','開封BOX数','number'],['condition','開封前の状態','select',['未選択','あり','なし','未開封','対象外']],['packProduct','残すバラパック名','text',1],['packQuantity','残すバラパック数（原価0円）','number'],['hits','主なカード','textarea',1],['estimatedValue','カード推定額','number'],['memo','メモ','textarea',1]],
 products:[['name','商品名','text',1],['category','種別','select',['BOX','パック','カード']],['code','商品コード・型番','text'],['marketPrice','参考価格','number'],['buybackPrice','買取価格','number'],['updated','価格更新日','date'],['memo','メモ','textarea',1]]
};
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const today=jstToday;
function setSyncStatus(message,kind=''){const el=document.querySelector('#sync-status');if(!el)return;el.textContent=message;el.className=`notice ${kind}`.trim()}
function fillSyncSettings(){const v2=getVaultV2Config(),url=document.querySelector('#sync-url'),token=document.querySelector('#sync-token');if(url&&!url.value)url.value=v2.url||'';if(token&&!token.value)token.value=v2.token||'';setSyncStatus(hasV2ReadOnly()?'V2接続設定済み':'V2接続が必要です',hasV2ReadOnly()?'success':'warning')}
function v2ModeLocked(){return true}
function assertWritable(){throw new Error('V2専用モードです。ローカル/V1保存は使用しません')}
function save(){assertWritable()}
function navHtml(){return nav.map(([r,i,l])=>`<a class="nav-link ${route===r?'active':''}" href="#${r}"><span class="nav-icon">${i}</span><span>${l}</span></a>`).join('')}
function metric(label,value,href=''){const body=`<span class="label">${label}</span><div class="metric-value">${yen.format(value)}</div>`;return href?`<a class="metric-card tappable" href="${href}">${body}<small>詳細を見る ›</small></a>`:`<article class="metric-card">${body}</article>`}
function empty(label){return`<div class="empty-state"><strong>まだ${label}はありません</strong>右上の「追加」から最初の記録を登録できます。</div>`}
const saleRevenue=x=>(+x.price||0)*(x.quantity==null?1:+x.quantity||0)-(+x.fee||0);
for(const item of [...state.purchases,...state.sales]){const category=String(item.category||'').trim();if(['シングル','シングルカード'].includes(category))item.category='カード';else if(['ボックス','未開封BOX'].includes(category))item.category='BOX';else if(category==='バラパック')item.category='パック'}
const realizedProfit=()=>state.sales.reduce((s,x)=>s+saleRevenue(x)-(+x.acquisitionCost||0),0);
function automationHealthHtml(){if(!v2ReadOnly)return'';const h=v2AutomationHealth||{},fmt=x=>x?new Date(x).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'未確認',nextGmail=x=>{if(!x)return'未確認';const d=new Date(x);if(isNaN(d.getTime()))return'未確認';d.setMinutes(d.getMinutes()+15);return d.toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'})+'前後'},badge=(s,n)=>`<span class="badge">${s==='ok'?'正常':s==='review'?`要確認 ${Number(n)||0}件`:'未確認'}</span>`;return`<section><div class="section-head"><h2>自動化</h2><span>V2 heartbeat</span></div><div class="panel automation-health"><div><strong>Gmail抽選</strong>${badge(h.gmailStatus,h.gmailReview)}<small>最終実行 ${fmt(h.lastGmailRunAt)} · 次回目安 ${nextGmail(h.lastGmailRunAt)}</small></div><div><strong>相場</strong>${badge(h.marketStatus,h.marketReview)}<small>最終実行 ${fmt(h.lastMarketRunAt)}</small></div></div></section>`}
function dashboard(){if(v2ReadOnly&&!v2Connected())return`<div class="notice warning">${hasV2ReadOnly()?'V2へ自動再接続中です。最新データ確認まで資産額は表示しません。':'V2接続設定が必要です。'}</div>`;const a=v2ReadOnly&&v2AssetsCache?v2AssetsCache:assets(state),max=Math.max(a.cards,a.boxes,a.packs,1),profit=v2ReadOnly&&v2ProfitCache!=null?v2ProfitCache:realizedProfit(),inventoryDifference=a.total-a.inventoryCost;return`<div class="hero-grid"><section class="hero-card"><span class="label">推定総資産</span><div class="hero-value">${yen.format(a.total)}</div><span class="delta ${inventoryDifference<0?'negative':''}">現在庫取得原価との差額 ${inventoryDifference>=0?'+':''}${yen.format(inventoryDifference)}</span></section><section class="hero-card profit"><span class="label">実現損益</span><div class="hero-value">${profit>=0?'+':''}${yen.format(profit)}</div><span class="delta ${profit<0?'negative':''}">売却済みのみ</span></section></div><div class="metric-grid">${metric('現在庫取得原価',a.inventoryCost)}${metric('カード推定資産',a.cards,'#inventory/cards')}${metric('BOX推定資産',a.boxes,'#inventory/boxes')}${metric('バラパック推定資産',a.packs,'#inventory/packs')}${metric('累計購入額',a.purchases)}${metric('売却累計',state.sales.reduce((s,x)=>s+saleRevenue(x),0))}</div><section><div class="section-head"><h2>資産構成</h2><span>項目をタップして在庫へ</span></div><div class="panel allocation">${[['カード',a.cards,'cards'],['BOX',a.boxes,'boxes'],['パック',a.packs,'packs']].map(([l,v,k])=>`<a class="bar-row" href="#inventory/${k}"><span>${l}</span><div class="bar"><i style="width:${v/max*100}%"></i></div><strong>${yen.format(v)}</strong></a>`).join('')}</div></section>${automationHealthHtml()}`}
function list(items,type){if(!items.length)return empty(({lotteries:'抽選',purchases:'購入記録',sales:'売却記録',boxes:'BOX',packs:'パック',cards:'カード',openings:'開封記録',products:'商品'}[type]||'記録'));return`<div class="list">${items.map(x=>{const market=['boxes','packs','cards'].includes(type)&&x.marketPrice!=null;const unit=market?yen.format(+x.marketPrice||0):'';const total=market?yen.format((+x.marketPrice||0)*(+x.quantity||1)):(x.price||x.marketPrice||x.buybackPrice?yen.format((+x.price||+x.marketPrice||+x.buybackPrice||0)*(+x.quantity||1)):'');const checked=market&&x.marketCheckedAt?` · 相場取得日 ${esc(x.marketCheckedAt)}`:'';const trend=market?(x.marketFresh===false?'stale':x.marketTrend||'same'):'';const diff=market&&x.marketPreviousPrice!=null?(+x.marketPrice||0)-(+x.marketPreviousPrice||0):0;const trendLabel=trend==='up'?`↑ +${yen.format(diff)}`:trend==='down'?`↓ ${yen.format(diff)}`:trend==='stale'?'前回価格維持':'→ 同額';return`<article class="list-item"><div><h3>${esc(x.title||x.product||x.name||'名称未設定')}${type==='cards'&&x.set&&!String(x.product||'').includes(x.set)?` ${esc(x.set)}`:''}${type==='cards'&&x.variant?` (${esc(x.variant)})`:''}</h3><div class="list-meta">${esc(x.store||x.set||x.category||'')}${x.date?` · ${esc(x.date)}`:''}${transactionQtyText(x)?` · <span class="transaction-qty">${esc(transactionQtyText(x))}</span>`:''}${x.marketSource?` · 買取: ${esc(x.marketSource)}`:''}${checked}</div>${x.status?`<span class="badge">${esc(x.status)}</span>`:''}${type==='cards'&&x.identityNeedsReview?`<span class="badge">番号は価格から推定・要確認</span>`:''}</div><div><div class="amount ${market?`market-${trend}`:'' }">${total}</div>${market?`<small class="market-${trend}">相場 ${unit}/点 · ${trendLabel}</small>`:''}${type==='cards'&&v2ReadOnly?`<button type="button" data-card-set="${esc(x.id)}">${x.set?'番号を修正':'番号を登録'}</button>`:''}${v2ReadOnly?'':`<button class="danger-link" data-delete="${type}" data-id="${esc(x.id)}">削除</button>`}</div></article>`}).join('')}</div>`}
function tabs(options){return`<div class="tabs">${options.map(([k,l])=>`<button class="tab ${subtype===k?'active':''}" data-subtype="${k}">${l}</button>`).join('')}</div>`}
const receiptStatus=x=>x.receiptStatus==='要確認'?'未受取':x.receiptStatus||(x.status==='購入済'?'受取済み':x.status==='当選'?'未受取':'対象外');
function lotteryWriteReady(){return !v2ModeLocked()||(v2Connected()&&isV2WriteEnabled(Number(remoteRevision)))}
async function applyLotteryManualPatches(patches,message){
 if(v2ModeLocked()){
  if(!v2Connected())throw new Error('V2接続を確認してください');
  if(!isV2WriteEnabled(Number(remoteRevision)))throw new Error('設定からV2書込を有効化してください');
  const saved=await commitV2LotteryManualPatches(patches);
  const check=acceptanceSnapshot(saved.payload);if(!check.ok)throw new Error('保存後の受入チェックに失敗しました');
  const applied=applyV2ReadOnlyToUi(state,{state:(await import('../v2/view-model.js')).v2ViewModel(saved.payload),assets:check.assets,realizedProfit:check.realizedProfit,revision:saved.revision});
  state=applied.state;v2AssetsCache=applied.assets;v2ProfitCache=applied.realizedProfit;remoteRevision=String(saved.revision);advanceV2WriteRevision(Number(remoteRevision));render();setSyncStatus(`抽選更新済み · rev ${remoteRevision} · 書込継続中`,'success');toast(message);return;
 }
 for(const patch of patches){const item=state.lotteries.find(x=>x.id===patch.id);if(!item)continue;Object.assign(item,patch);if(patch.status==='落選'){item.receiptStatus='対象外';item.receivedDate=''}else if(patch.status==='当選'&&item.receiptStatus!=='受取済み')item.receiptStatus='未受取';else if(patch.status==='購入済'){item.receiptStatus='受取済み';if(!item.receivedDate)item.receivedDate=today()}}
 save(state);render();toast(message);
}
function calendar(){
 const [year,month]=calendarMonth.split('-').map(Number),first=new Date(year,month-1,1),days=new Date(year,month,0).getDate(),start=first.getDay();
 const events=new Map();const add=(date,item,label,kind)=>{if(!date||date.slice(0,7)!==calendarMonth)return;const key=date.slice(0,10);if(!events.has(key))events.set(key,[]);events.get(key).push({item,label,kind})};
 for(const x of state.lotteries){add((x.deadline||'').slice(0,10),x,'応募締切','deadline');add(x.resultDate,x,'結果','result');add(x.receiveDeadline,x,'購入期限','receipt')}
 const weekdays=['日','月','火','水','木','金','土'];
 const cells=[];for(let i=0;i<start;i++)cells.push('<div class="calendar-day muted"></div>');
 for(let day=1;day<=days;day++){const date=`${calendarMonth}-${String(day).padStart(2,'0')}`,items=events.get(date)||[],results=items.filter(x=>x.kind==='result'),count=kind=>items.filter(x=>x.kind===kind).length,statusCount=status=>results.filter(x=>x.item.status===status).length;const counts=[['win','当選',results.filter(x=>['当選','購入済'].includes(x.item.status)).length],['loss','落選',statusCount('落選')],['pending','結果待ち',results.filter(x=>!['当選','落選','購入済'].includes(x.item.status)).length],['deadline','締切',count('deadline')],['receipt','購入',count('receipt')]].filter(x=>x[2]).map(([kind,label,n])=>`<span class="calendar-count ${kind}">${label} ${n}件</span>`).join('');cells.push(`<button class="calendar-day ${selectedCalendarDate===date?'selected':''} ${today()===date?'today':''}" data-calendar-day="${date}"><strong>${day}</strong>${counts}</button>`)}
 const pending=state.lotteries.filter(x=>receiptStatus(x)==='未受取'),review=[];
 const selected=events.get(selectedCalendarDate)||[],selectedResults=selected.filter(x=>x.kind==='result');const details=selected.length?selected.map(({item,label,kind})=>{const received=receiptStatus(item),status=item.status||'未設定',statusClass=status==='当選'||status==='購入済'?'win':status==='落選'?'loss':'pending';const action=lotteryWriteReady()&&['当選','購入済'].includes(status)?`<button class="receipt-button" data-received-id="${esc(item.id)}">${received==='受取済み'?'受取情報を編集':'📷 写真・受取登録'}</button>`:'';const controls=lotteryWriteReady()&&kind==='result'&&status!=='購入済'?`<div class="result-controls"><button data-lottery-status="当選" data-lottery-id="${esc(item.id)}">当選</button><button data-lottery-status="落選" data-lottery-id="${esc(item.id)}">落選</button></div>`:'';return`<article class="calendar-detail ${esc(kind)} status-${statusClass}"><div><b>${esc(label)} · ${esc(status)}</b><h3>${esc(item.title)}</h3><span>${esc(item.store||'')}</span><dl><div><dt>応募締切</dt><dd>${esc((item.deadline||'未設定').replace('T',' '))}</dd></div><div><dt>結果発表</dt><dd>${esc(item.resultDate||'未設定')}</dd></div><div><dt>購入期限</dt><dd>${esc(item.receiveDeadline||'未設定')}</dd></div><div><dt>受取状況</dt><dd>${esc(received)}</dd></div><div><dt>受取日</dt><dd>${esc(item.receivedDate||'未設定')}</dd></div><div><dt>シュリンク</dt><dd>${esc(item.shrinkStatus||'未選択')}</dd></div></dl>${item.receiptPhoto?`<img class="receipt-photo" src="${esc(item.receiptPhoto)}" alt="レシート写真">`:''}${item.memo?`<p>${esc(item.memo)}</p>`:''}${controls}</div>${action}</article>`}).join(''):`<div class="calendar-empty">この日の予定はありません</div>`;
 const reviewDetails=reviewExpanded&&review.length?`<section class="review-details"><div class="section-head"><h2>要確認の詳細</h2><span>${review.length}件</span></div><div class="list">${review.map(item=>`<article class="calendar-detail status-pending"><div><b>${esc(item.status||'状態未設定')} · ${esc(receiptStatus(item))}</b><h3>${esc(item.title||'名称未設定')}</h3><span>${esc(item.store||'店舗未設定')}</span><dl><div><dt>結果発表</dt><dd>${esc(item.resultDate||'未設定')}</dd></div><div><dt>購入期限</dt><dd>${esc(item.receiveDeadline||item.purchaseDeadline||'未設定')}</dd></div><div><dt>受取日</dt><dd>${esc(item.receivedDate||'未設定')}</dd></div></dl>${item.memo?`<p>${esc(item.memo)}</p>`:''}</div><button class="receipt-button" data-received-id="${esc(item.id)}">📷 写真・受取登録</button></article>`).join('')}</div></section>`:'';
 const pendingDetails=pendingExpanded&&pending.length?`<section class="review-details pending-details"><div class="section-head"><h2>未受取の詳細</h2><span>${pending.length}件</span></div><div class="list">${pending.map(item=>`<article class="calendar-detail status-win"><div><b>${esc(item.status||'当選')} · 未受取</b><h3>${esc(item.title||'名称未設定')}</h3><span>${esc(item.store||'店舗未設定')}</span><dl><div><dt>結果発表</dt><dd>${esc(item.resultDate||'未設定')}</dd></div><div><dt>購入期限</dt><dd>${esc(item.receiveDeadline||item.purchaseDeadline||'未設定')}</dd></div><div><dt>受取期間</dt><dd>${esc(item.receivePeriod||'未設定')}</dd></div></dl>${item.memo?`<p>${esc(item.memo)}</p>`:''}</div><button class="receipt-button" data-received-id="${esc(item.id)}">📷 写真・受取登録</button></article>`).join('')}</div></section>`:'';
 const importButton='';
 return `${importButton}<div class="calendar-toolbar"><button class="secondary-button compact" data-calendar-move="-1">‹ 前月</button><h2>${year}年${month}月</h2><button class="secondary-button compact" data-calendar-move="1">次月 ›</button></div>${pending.length?`<button class="pending-receipts pending-toggle" data-show-pending aria-expanded="${pendingExpanded}"><b>未受取 ${pending.length}件</b><span>タップして詳細を${pendingExpanded?'閉じる':'表示'}</span></button>`:''}${pendingDetails}${review.length?`<button class="pending-receipts review review-toggle" data-show-review aria-expanded="${reviewExpanded}"><b>要確認 ${review.length}件</b><span>タップして詳細を${reviewExpanded?'閉じる':'表示'}</span></button>`:''}${reviewDetails}<div class="calendar-weekdays">${weekdays.map(x=>`<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells.join('')}</div><section class="calendar-details"><div class="section-head"><h2>${esc(selectedCalendarDate)} の予定</h2>${lotteryWriteReady()&&selectedResults.length?`<button class="secondary-button compact" data-lottery-bulk-loss="${esc(selectedCalendarDate)}">この日の結果を全て落選</button>`:''}</div>${details}</section>`
}
function inventory(){const options=[['boxes','未開封BOX'],['packs','バラパック'],['cards','カード']];const items=(state[subtype]||state.boxes).filter(x=>Number(x.quantity)>0);if(v2ReadOnly&&!v2Connected())return`<div class="notice warning">${hasV2ReadOnly()?'V2へ自動再接続中です。':'V2接続設定が必要です。'} 誤表示防止のためローカル在庫は表示していません。</div>`+tabs(options);const source=v2ReadOnly?`<div class="notice success">表示元: V2正本 · rev ${esc(remoteRevision)} · ${esc(subtype)} ${items.length}件</div>`:`<div class="notice warning">表示元: ローカルデータ</div>`;return source+tabs(options)+list(items,subtype)}
function transactionTone(x){const text=[x?.store,x?.memo,x?.source,x?.acquisitionSource,x?.note].filter(Boolean).join(' ');if(x?._kind==='売却')return'sale';if(x?._kind==='開封'||/開封獲得/.test(text))return'opening';return'purchase'}
function transactionUnit(x){const category=String(x?.category||'').trim(),product=String(x?.product||x?.title||'');if(category==='BOX')return'BOX';if(category==='パック')return'パック';if(category==='カード')return'枚';if(/スタートデッキ|デッキセット|構築済みデッキ|BOX/i.test(product))return'BOX';if(/パック/.test(product))return'パック';return'個'}
function transactionQtyText(x){const n=Number(x?.quantity);if(!Number.isFinite(n)||n<=0)return'';return String(n)+transactionUnit(x)+(x?._kind==='開封'?'開封':'')}
function transactionUnitPriceText(x){const n=Number(x?.quantity),p=Number(x?.price);return Number.isFinite(n)&&n>1&&Number.isFinite(p)&&p>0?'単価 '+yen.format(p):''}
function ledger(){const months=[...new Set([...state.purchases,...state.sales].map(x=>(x.date||'').slice(0,7)).filter(Boolean))].sort().reverse(),month=subtype?.match(/^\d{4}-\d{2}$/)?subtype:months[0]||today().slice(0,7),p=state.purchases.filter(x=>(x.date||'').startsWith(month)),s=state.sales.filter(x=>(x.date||'').startsWith(month)),spent=p.reduce((n,x)=>n+(+x.total||(+x.price||0)*(+x.quantity||1)),0),revenue=s.reduce((n,x)=>n+saleRevenue(x),0),settled=s.filter(x=>x.acquisitionCost!=null),pendingCost=s.length-settled.length,cost=settled.reduce((n,x)=>n+Number(x.acquisitionCost),0),settledRevenue=settled.reduce((n,x)=>n+saleRevenue(x),0),profit=settledRevenue-cost,recovery=cost?`${Math.round(settledRevenue/cost*100)}%`:'—',categories=['BOX','カード','パック','その他'].map(category=>{const cp=p.filter(x=>(x.category||'その他')===category),cs=s.filter(x=>(x.category||'その他')===category);return[category,cp.reduce((n,x)=>n+(+x.total||(+x.price||0)*(+x.quantity||1)),0),cs.reduce((n,x)=>n+saleRevenue(x),0)]}),rows=[...p.map(x=>({...x,_kind:'購入',_collection:'purchases'})),...s.map(x=>({...x,_kind:'売却',_collection:'sales'}))].sort((a,b)=>(b.date||'').localeCompare(a.date||''));return`<div class="month-tabs">${months.map(m=>`<button class="tab ${m===month?'active':''}" data-month="${m}">${m}</button>`).join('')}</div><div class="metric-grid">${metric('購入額',spent)}${metric('売却額',revenue)}${metric(pendingCost?`実現損益（原価確定分・未確定${pendingCost}件）`:'実現損益',profit)}<article class="metric-card"><span class="label">回収率（原価確定分）</span><div class="metric-value">${recovery}</div></article></div><section><div class="section-head"><h2>種別内訳</h2></div><div class="panel finance-breakdown">${categories.map(([c,buy,sale])=>`<div><b>${c}</b><span>購入 ${yen.format(buy)}</span><span>売却 ${yen.format(sale)}</span></div>`).join('')}</div></section>${rows.length?`<div class="list">${rows.map(x=>`<article class="list-item txn-${transactionTone(x)}"><div><h3>${esc(x.product||'名称未設定')}</h3><div class="list-meta">${esc(x._kind)} · ${esc(x.store||'')}${x.date?` · ${esc(x.date)}`:''}${transactionQtyText(x)?` · <span class="transaction-qty">${esc(transactionQtyText(x))}</span>`:''}</div></div><div><div class="amount">${yen.format(x._kind==='売却'?saleRevenue(x):(+x.total||(+x.price||0)*(+x.quantity||1)))}</div>${transactionUnitPriceText(x)?`<div class="transaction-detail">${esc(transactionUnitPriceText(x))}</div>`:''}${v2ReadOnly?'':`<button class="danger-link" data-delete="${x._collection}" data-id="${esc(x.id)}">削除</button>`}</div></article>`).join('')}</div>`:empty('収支記録')}`}
function activity(){const all=[...state.purchases.map(x=>({...x,_kind:'購入'})),...state.sales.map(x=>({...x,_kind:'売却'}))].sort((a,b)=>(b.date||'').localeCompare(a.date||''));return all.length?`<div class="list">${all.map(x=>`<article class="list-item txn-${transactionTone(x)}"><div><h3>${esc(x.product||x.title)}</h3><div class="list-meta">${esc(x._kind)} · ${esc(x.store||'')}${x.date?` · ${esc(x.date)}`:''}${transactionQtyText(x)?` · <span class="transaction-qty">${esc(transactionQtyText(x))}</span>`:''}</div></div><div><div class="amount">${x.price?yen.format((+x.price||0)*(+x.quantity||1)):''}</div>${transactionUnitPriceText(x)?`<div class="transaction-detail">${esc(transactionUnitPriceText(x))}</div>`:''}</div></article>`).join('')}</div>`:empty('履歴')}
function v2Connected(){return v2ReadOnly&&/^\d+$/.test(String(remoteRevision))}
function render(){if(!titles[route])route='dashboard';document.querySelector('#page-title').textContent=titles[route];document.querySelector('#desktop-nav').innerHTML=navHtml();document.querySelector('#mobile-nav').innerHTML=navHtml();const views={dashboard,calendar,lotteries:()=>list(state.lotteries,'lotteries'),ledger,inventory,activity};document.querySelector('#view').innerHTML=views[route]();document.querySelector('[data-action="add-current"]').hidden=(v2ModeLocked()&&(!v2Connected()||!isV2WriteEnabled(Number(remoteRevision))))||(route==='activity'&&subtype==='stores')}
const pendingPresets={};
function applyPendingPreset(type){const preset=pendingPresets[type];if(!preset)return;for(const [name,value] of Object.entries(preset)){const el=document.querySelector('#entry-form [name="'+name+'"]');if(el)el.value=String(value)}}
function openForm(type){if(type==='dashboard')type='purchases';if(v2ModeLocked()&&!v2Connected()){toast('V2へ自動再接続できるまで保存できません');return}if(v2ModeLocked()&&!isV2WriteEnabled(Number(remoteRevision))){toast('V2確認モードは読み取り専用です');return}if(type==='calendar')type='lotteries';if(type==='ledger')type=subtype==='sales'?'sales':'purchases';if(type==='inventory')type=['boxes','packs','cards','products'].includes(subtype)?subtype:'boxes';if(type==='activity')type='openings';const f=fields[type];if(!f)return;document.querySelector('#entry-form').dataset.type=type;document.querySelector('#form-title').textContent=`${({lotteries:'抽選',purchases:'購入',sales:'売却',boxes:'BOX',packs:'パック',cards:'カード',openings:'開封',products:'商品'}[type])}を追加`;document.querySelector('#form-fields').innerHTML=f.map(([name,label,kind,extra])=>{const full=extra===1?' full':'';if(kind==='select')return`<div class="field${full}"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${extra.map(o=>`<option>${o}</option>`).join('')}</select></div>`;if(kind==='textarea')return`<div class="field${full}"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}"></textarea></div>`;return`<div class="field${full}"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${kind}" ${kind==='number'?'min="0" inputmode="numeric"':''} ${name==='quantity'?'value="1"':''} ${name==='date'?'value="'+today()+'"':''} ${['title','product','name'].includes(name)?'required':''}></div>`}).join('');applyPendingPreset(type);document.querySelector('#entry-dialog').showModal()}

let receiptOcrLoader=null,receiptPreparedPhoto=null;
function receiptCategoryFor(item){const s=String(item?.receiptCategory||item?.category||item?.title||'');if(/スタートデッキ|デッキセット|カードセット|BOX|ボックス/i.test(s))return'BOX';if(/パック/.test(s))return'パック';if(/\d{1,3}\/\d{1,3}|カード/.test(s)&&!/セット/.test(s))return'カード';return'BOX'}
function setReceiptOcrStatus(text,tone=''){const el=document.querySelector('#receipt-ocr-status');if(!el)return;el.textContent=text;el.dataset.tone=tone}
function loadReceiptOcr(){
 if(globalThis.Tesseract)return Promise.resolve(globalThis.Tesseract);
 if(receiptOcrLoader)return receiptOcrLoader;
 receiptOcrLoader=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';s.crossOrigin='anonymous';s.onload=()=>globalThis.Tesseract?resolve(globalThis.Tesseract):reject(new Error('OCRエンジンを読み込めませんでした'));s.onerror=()=>reject(new Error('OCRエンジンの読み込みに失敗しました'));document.head.appendChild(s)});return receiptOcrLoader;
}
function receiptDateFromOcr(text){
 const s=String(text||'').normalize('NFKC');
 const m=s.match(/(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*日?/);
 if(!m)return'';const y=m[1],mo=String(Number(m[2])).padStart(2,'0'),d=String(Number(m[3])).padStart(2,'0');return y+'-'+mo+'-'+d;
}
function receiptAmountFromOcr(text){
 const lines=String(text||'').normalize('NFKC').split(/\r?\n/).map(x=>x.trim()).filter(Boolean),candidates=[];
 for(const line of lines){
  const nums=[...line.matchAll(/[¥￥]?\s*([0-9][0-9,]{1,8})\s*円?/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(n=>Number.isFinite(n)&&n>=100&&n<=10000000);
  if(!nums.length)continue;
  let score=0;if(/合\s*計|total|お支払|支払額|請求額/i.test(line))score+=12;if(/税込|クレジット|決済/i.test(line))score+=4;if(/小計/.test(line))score+=2;if(/内税|外税|消費税|ポイント|釣銭|お釣|預り|預かり|電話|TEL/i.test(line))score-=8;
  for(const amount of nums)candidates.push({amount,score,line});
 }
 candidates.sort((a,b)=>b.score-a.score||b.amount-a.amount);return candidates[0]||null;
}
function parseReceiptOcr(text){
 const amount=receiptAmountFromOcr(text),date=receiptDateFromOcr(text);
 return{amount:amount?.amount||0,amountLine:amount?.line||'',date};
}
async function recognizeReceiptPhoto(source){
 const Tesseract=await loadReceiptOcr();setReceiptOcrStatus('OCR準備中…');
 const worker=await Tesseract.createWorker(['jpn','eng'],1,{logger:m=>{if(m?.status==='recognizing text'&&Number.isFinite(m.progress))setReceiptOcrStatus('OCR '+Math.round(m.progress*100)+'%')}});
 try{const result=await worker.recognize(source);return String(result?.data?.text||'')}finally{await worker.terminate()}
}

function openReceiptDialog(item){
 if(v2ReadOnly&&!v2Connected()){toast('V2接続を確認してください');return}
 receiptTargetId=item.id;
 document.querySelector('#receipt-product').value=item.receiptProduct||item.title||'';
 document.querySelector('#receipt-store').value=item.receiptStore||item.store||'';
 document.querySelector('#receipt-date').value=item.receivedDate||today();
 document.querySelector('#receipt-total').value=item.receiptAmount||'';
 document.querySelector('#receipt-quantity').value=item.receiptQuantity||1;
 document.querySelector('#receipt-category').value=receiptCategoryFor(item);
 document.querySelector('#receipt-shrink').value=item.shrinkStatus||'未選択';
 document.querySelector('#receipt-add-purchase').checked=item.status!=='購入済';
 document.querySelector('#receipt-photo').value='';
 document.querySelector('#receipt-camera').value='';
 receiptPreparedPhoto=null;
 const preview=document.querySelector('#receipt-preview');
 preview.src=item.receiptPhoto||'';preview.hidden=!item.receiptPhoto;
 const review=document.querySelector('#receipt-ocr-review');review.hidden=true;review.textContent='';
 setReceiptOcrStatus('端末内OCR・外部AI送信なし');
 document.querySelector('#receipt-dialog').showModal();
}
function receiptJpegFromImage(image,max,quality){
 const width=Number(image.naturalWidth||image.width),height=Number(image.naturalHeight||image.height);
 if(!width||!height)throw new Error('写真サイズを取得できません');
 const scale=Math.min(1,max/Math.max(width,height)),canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
 canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
 const data=canvas.toDataURL('image/jpeg',quality);
 if(!data.startsWith('data:image/jpeg'))throw new Error('写真をJPEGへ変換できません');
 return data;
}
async function prepareReceiptPhoto(file){
 if(!file)throw new Error('写真が選択されていません');
 let image=null;
 try{
  image=await createImageBitmap(file);
  return{stored:receiptJpegFromImage(image,1024,.68),ocr:receiptJpegFromImage(image,1800,.88)};
 }catch(bitmapError){
  const url=URL.createObjectURL(file);
  try{
   const htmlImage=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('選択した写真を読み込めません'));img.src=url});
   return{stored:receiptJpegFromImage(htmlImage,1024,.68),ocr:receiptJpegFromImage(htmlImage,1800,.88)};
  }finally{URL.revokeObjectURL(url)}
 }finally{if(image&&typeof image.close==='function')image.close()}
}
async function compressReceiptPhoto(file){return (await prepareReceiptPhoto(file)).stored}
function toast(msg){const el=document.querySelector('#toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function download(name,text){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'application/json'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function readFile(input){const file=input.files[0];if(!file)return null;return file.text()}

const receiptPhotoInputs=['receipt-camera','receipt-photo'];
const selectedReceiptPhoto=()=>receiptPhotoInputs.map(id=>document.querySelector('#'+id)?.files?.[0]).find(Boolean)||null;
async function handleReceiptPhotoSelection(e){
 const file=e.target.files?.[0],preview=document.querySelector('#receipt-preview');
 receiptPreparedPhoto=null;
 if(!file){const item=state.lotteries.find(x=>x.id===receiptTargetId);preview.src=item?.receiptPhoto||'';preview.hidden=!item?.receiptPhoto;return}
 for(const id of receiptPhotoInputs)if(id!==e.target.id)document.querySelector('#'+id).value='';
 try{
  receiptPreparedPhoto=await prepareReceiptPhoto(file);
  preview.src=receiptPreparedPhoto.stored;preview.hidden=false;
  setReceiptOcrStatus(e.target.id==='receipt-camera'?'撮影した写真を準備しました。読み取りを押してください':'保存済み写真を準備しました。読み取りを押してください');
 }catch(err){
  receiptPreparedPhoto=null;preview.hidden=true;
  setReceiptOcrStatus('写真の読み込みに失敗しました。別の画像を選んでください','warning');
  const review=document.querySelector('#receipt-ocr-review');review.textContent=String(err.message||err);review.hidden=false;
 }
}
for(const id of receiptPhotoInputs)document.querySelector('#'+id).addEventListener('change',handleReceiptPhotoSelection);
document.querySelector('#receipt-ocr-button').addEventListener('click',async()=>{
 const file=selectedReceiptPhoto();
 if(!file){alert('先にレシート・購入証拠の写真を選んでください');return}
 const button=document.querySelector('#receipt-ocr-button'),review=document.querySelector('#receipt-ocr-review');
 button.disabled=true;review.hidden=true;
 try{
  if(!receiptPreparedPhoto)receiptPreparedPhoto=await prepareReceiptPhoto(file);
  const raw=await recognizeReceiptPhoto(receiptPreparedPhoto.ocr),parsed=parseReceiptOcr(raw);
  if(parsed.amount)document.querySelector('#receipt-total').value=String(parsed.amount);
  if(parsed.date)document.querySelector('#receipt-date').value=parsed.date;
  const lines=[];
  lines.push(parsed.amount?'金額候補: '+yen.format(parsed.amount):'金額候補: 読み取れませんでした');
  lines.push(parsed.date?'日付候補: '+parsed.date:'日付候補: 読み取れませんでした');
  if(parsed.amountLine)lines.push('根拠行: '+parsed.amountLine.slice(0,100));
  review.textContent=lines.join(' / ');review.hidden=false;
  setReceiptOcrStatus(parsed.amount||parsed.date?'OCR完了。内容を確認して保存してください':'OCR完了。候補を取れなかったため手入力してください',parsed.amount||parsed.date?'success':'warning');
 }catch(err){
  setReceiptOcrStatus('OCR失敗。手入力で保存できます','warning');review.textContent=String(err.message||err);review.hidden=false;
 }finally{button.disabled=false}
});
document.addEventListener('click',async e=>{const a=e.target.closest('[data-action]');if(a){const act=a.dataset.action;if(act==='add-current')openForm(route);if(act==='close-dialog')document.querySelector('#entry-dialog').close();if(act==='open-settings'){document.querySelector('#settings-dialog').showModal();fillSyncSettings();if(v2Connected()){setSyncStatus(`V2確認モード · revision ${remoteRevision}`,'success');const box=document.querySelector('#v2-write-controls');if(box)box.hidden=false;const on=isV2WriteEnabled(Number(remoteRevision));const en=document.querySelector('[data-action="enable-v2-write"]'),off=document.querySelector('[data-action="disable-v2-write"]');if(en)en.hidden=on;if(off)off.hidden=!on}}if(act==='close-settings')document.querySelector('#settings-dialog').close();if(act==='export-json'){try{const snapshot=await tryLoadV2ReadOnly();download(`toreca-vault-v2-${today()}.json`,JSON.stringify({app:'toreca-vault',schemaVersion:2,exportedAt:new Date().toISOString(),revision:snapshot.revision,data:snapshot.canonical},null,2));toast('V2正本を書き出しました')}catch(err){alert('V2バックアップ失敗: '+String(err.message||err))}}if(act==='connect-sync'){try{e.preventDefault();enableV2ReadOnly(document.querySelector('#sync-url').value,document.querySelector('#sync-token').value);setSyncStatus('V2接続確認中…');const snapshot=await tryLoadV2ReadOnly(),check=acceptanceSnapshot(snapshot.canonical),migration=pendingMigrationSnapshot(snapshot.canonical);if(!check.ok)throw new Error(`V2受入チェック失敗: ${check.issues.join(', ')}`);if(Number(snapshot.revision)>=3&&!migration.ok)throw new Error(`V2移行整合性エラー: 取引欠落${migration.missingTransactions.length}件`);const applied=applyV2ReadOnlyToUi(state,snapshot);state=applied.state;v2ReadOnly=true;v2AssetsCache=applied.assets;v2ProfitCache=applied.realizedProfit;v2AutomationHealth=applied.automationHealth||{};remoteRevision=String(applied.revision??'');advanceV2WriteRevision(Number(remoteRevision));document.querySelector('#sync-token').value='';render();const writeBox=document.querySelector('#v2-write-controls');if(writeBox)writeBox.hidden=false;const writeOn=isV2WriteEnabled(Number(remoteRevision));const writeEnable=document.querySelector('[data-action="enable-v2-write"]'),writeDisable=document.querySelector('[data-action="disable-v2-write"]');if(writeEnable)writeEnable.hidden=writeOn;if(writeDisable)writeDisable.hidden=!writeOn;setSyncStatus(`V2確認OK · rev ${applied.revision} · 取引${check.counts.transactions}件 · 在庫${check.counts.inventoryQuantity}点 · 移行${migration.requiredTxCount}取引確認済み`,'success');toast('V2へ安全に接続しました')}catch(err){v2ReadOnly=true;render();setSyncStatus(err.message,'warning')}}if(act==='sync-now'){e.preventDefault();if(!hasV2ReadOnly()){setSyncStatus('先にV2へ接続してください','warning');return}const ok=await connectV2Remote_(true);if(ok)toast('V2を再確認しました');return}if(act==='disconnect-sync'){e.preventDefault();v2ReadOnly=true;render();setSyncStatus('V2は永続接続モードです。ローカル運用には戻しません','warning');toast('V2永続接続を維持します')}if(act==='enable-v2-write'){e.preventDefault();if(!v2Connected()){toast('V2確認後に有効化できます');return}const phrase=prompt('確認のため「V2書込を有効化」と入力してください');if(phrase===null)return;try{enableV2WriteForSession(phrase,Number(remoteRevision));render();setSyncStatus(`V2書込常時ON · rev ${remoteRevision}`,'warning');toast('この端末でV2書込を常時有効化しました')}catch(err){alert(err.message)}}if(act==='disable-v2-write'){e.preventDefault();disableV2Write();render();setSyncStatus(`V2確認モード · revision ${remoteRevision}`,'success');toast('V2書込を無効化しました')}}const cardSetButton=e.target.closest('[data-card-set]');if(cardSetButton){e.preventDefault();try{if(!v2Connected()||!isV2WriteEnabled(Number(remoteRevision)))throw new Error('設定からV2書込を有効化してください');const item=state.cards.find(x=>x.id===cardSetButton.dataset.cardSet);if(!item)throw new Error('カードが見つかりません');const value=prompt('カードに印刷された収録記号・番号を入力（例: M6a 127/103）',item.set||'');if(value===null)return;const saved=await commitV2CardIdentity(item.id,value);const check=acceptanceSnapshot(saved.payload);if(!check.ok)throw new Error('保存後の受入チェックに失敗しました');const applied=applyV2ReadOnlyToUi(state,{state:(await import('../v2/view-model.js')).v2ViewModel(saved.payload),assets:check.assets,realizedProfit:check.realizedProfit,revision:saved.revision});state=applied.state;v2AssetsCache=applied.assets;remoteRevision=String(saved.revision);advanceV2WriteRevision(Number(remoteRevision));render();setSyncStatus(`カード番号保存済み · rev ${remoteRevision} · 書込継続中`,'success');toast('カード番号をV2に保存しました')}catch(err){setSyncStatus('カード番号保存失敗 · '+String(err.message||err),'warning');alert(err.message)}return}const pendingToggle=e.target.closest('[data-show-pending]');if(pendingToggle){pendingExpanded=!pendingExpanded;render();if(pendingExpanded)requestAnimationFrame(()=>document.querySelector('.pending-details')?.scrollIntoView({behavior:'smooth',block:'nearest'}))}const reviewToggle=e.target.closest('[data-show-review]');if(reviewToggle){reviewExpanded=!reviewExpanded;render();if(reviewExpanded)requestAnimationFrame(()=>document.querySelector('.review-details')?.scrollIntoView({behavior:'smooth',block:'nearest'}))}const month=e.target.closest('[data-month]');if(month){subtype=month.dataset.month;render()}const move=e.target.closest('[data-calendar-move]');if(move){const [y,m]=calendarMonth.split('-').map(Number),d=new Date(y,m-1+Number(move.dataset.calendarMove),1);calendarMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;selectedCalendarDate=`${calendarMonth}-01`;render()}const day=e.target.closest('[data-calendar-day]');if(day){selectedCalendarDate=day.dataset.calendarDay;render();requestAnimationFrame(()=>document.querySelector('.calendar-details')?.scrollIntoView({behavior:'smooth',block:'nearest'}))}const result=e.target.closest('[data-lottery-status]');if(result){const item=state.lotteries.find(x=>x.id===result.dataset.lotteryId);if(item){try{const status=result.dataset.lotteryStatus;if(!confirm(`${item.title} を「${status}」に変更してV2へ反映しますか？`))return;await applyLotteryManualPatches([{id:item.id,status}],`${status}に変更しました`)}catch(err){setSyncStatus('抽選更新失敗 · '+String(err.message||err),'warning');alert(err.message)}return}}const bulkLoss=e.target.closest('[data-lottery-bulk-loss]');if(bulkLoss){try{const date=bulkLoss.dataset.lotteryBulkLoss,targets=state.lotteries.filter(x=>String(x.resultDate||'').slice(0,10)===date&&x.status!=='購入済'&&receiptStatus(x)!=='受取済み');if(!targets.length){toast('落選に変更できる抽選がありません');return}if(!confirm(`${date} の ${targets.length}件をすべて落選にしてV2へ反映しますか？`))return;await applyLotteryManualPatches(targets.map(x=>({id:x.id,status:'落選'})),`${targets.length}件を落選に変更しました`)}catch(err){setSyncStatus('一括落選更新失敗 · '+String(err.message||err),'warning');alert(err.message)}return}const received=e.target.closest('[data-received-id]');if(received){const item=state.lotteries.find(x=>x.id===received.dataset.receivedId);if(item)openReceiptDialog(item)}const tab=e.target.closest('[data-subtype]');if(tab){subtype=tab.dataset.subtype;render()}const del=e.target.closest('[data-delete]');if(del&&v2ModeLocked()){toast('V2永続接続モードではローカル削除できません');return}if(del&&confirm('この記録を削除しますか？')){state[del.dataset.delete]=state[del.dataset.delete].filter(x=>x.id!==del.dataset.id);save(state);render();toast('削除しました')}});
document.querySelector('#receipt-form').addEventListener('submit',async e=>{
 e.preventDefault();if(receiptSubmitting)return;receiptSubmitting=true;
 const button=document.querySelector('#receipt-submit-button'),item=state.lotteries.find(x=>x.id===receiptTargetId);
 if(button){button.disabled=true;button.dataset.originalText=button.textContent;button.textContent='V2へ保存中…'}
 setReceiptOcrStatus('V2へ受取情報を保存中…');
 if(!item){receiptSubmitting=false;if(button){button.disabled=false;button.textContent=button.dataset.originalText||'確認内容で受取済みにする'};return}
 try{
  const file=selectedReceiptPhoto(),quantity=Number(document.querySelector('#receipt-quantity').value||1),total=Number(document.querySelector('#receipt-total').value||0),addPurchase=document.querySelector('#receipt-add-purchase').checked;
  const payload={id:item.id,product:document.querySelector('#receipt-product').value.trim(),store:document.querySelector('#receipt-store').value.trim(),receivedDate:document.querySelector('#receipt-date').value||today(),total,quantity,category:document.querySelector('#receipt-category').value,shrinkStatus:document.querySelector('#receipt-shrink').value,addPurchase};
  if(file){if(!receiptPreparedPhoto)receiptPreparedPhoto=await prepareReceiptPhoto(file);payload.receiptPhoto=receiptPreparedPhoto.stored;}
  if(addPurchase&&total<=0)throw new Error('購入履歴へ追加する場合は購入合計金額を確認してください');
  if(v2ModeLocked()){
   if(!v2Connected())throw new Error('V2へ自動再接続できていません。ローカル保存は行いません');
   if(!isV2WriteEnabled(Number(remoteRevision))){
    if(!confirm('V2正本へ保存するため、この端末のV2書込を今後も有効にしますか？\n設定からいつでもOFFにできます。'))return;
    enableV2WriteForSession('V2書込を有効化',Number(remoteRevision));
    setSyncStatus(`V2書込常時ON · rev ${remoteRevision}`,'warning');
   }
   const saved=await commitV2LotteryReceiptPurchase(payload),check=acceptanceSnapshot(saved.payload);if(!check.ok)throw new Error('保存後の受入チェックに失敗しました');
   const applied=applyV2ReadOnlyToUi(state,{state:(await import('../v2/view-model.js')).v2ViewModel(saved.payload),assets:check.assets,realizedProfit:check.realizedProfit,revision:saved.revision});
   state=applied.state;v2AssetsCache=applied.assets;v2ProfitCache=applied.realizedProfit;v2AutomationHealth=applied.automationHealth||v2AutomationHealth;remoteRevision=String(saved.revision);advanceV2WriteRevision(Number(remoteRevision));render();setSyncStatus(`受取・購入反映済み · rev ${remoteRevision} · 書込継続中`,'success');
  }else{
   item.status='購入済';item.receiptStatus='受取済み';item.receivedDate=payload.receivedDate;item.shrinkStatus=payload.shrinkStatus;if(payload.receiptPhoto)item.receiptPhoto=payload.receiptPhoto;item.receiptAmount=total;item.receiptProduct=payload.product;item.receiptStore=payload.store;item.receiptQuantity=quantity;item.receiptCategory=payload.category;
   if(addPurchase){const txId='lottery-receipt-purchase-'+item.id;if(!state.purchases.some(x=>x.id===txId))state=applyPurchase(state,{id:txId,date:payload.receivedDate,store:payload.store,product:payload.product,quantity,price:total/quantity,total,category:payload.category,condition:payload.category==='BOX'?'未開封':'',memo:'抽選受取｜レシート確認'})}
   save(state);render();
  }
  document.querySelector('#receipt-dialog').close();toast(addPurchase?'受取済み・購入履歴へ反映しました':'受取済みに変更しました');
 }catch(err){setSyncStatus('受取更新失敗 · '+String(err.message||err),'warning');setReceiptOcrStatus('保存失敗: '+String(err.message||err),'warning');alert(err.message)}
 finally{receiptSubmitting=false;if(button){button.disabled=false;button.textContent=button.dataset.originalText||'確認内容で受取済みにする'}}
});
let receiptSubmitting=false,entrySubmitting=false;
document.querySelector('#entry-form').addEventListener('submit',async e=>{e.preventDefault();if(entrySubmitting)return;entrySubmitting=true;const type=e.currentTarget.dataset.type;if(v2ModeLocked()&&!v2Connected()){entrySubmitting=false;setSyncStatus('V2保存失敗 · V2接続が完了していません。ローカル保存を停止しました','warning');toast('V2保存失敗・未反映');alert('V2接続が完了していません。ローカル保存を停止しました');return}const data=Object.fromEntries(new FormData(e.currentTarget));for(const k of ['quantity','packQuantity','price','cost','marketPrice','buybackPrice','fee','estimatedValue'])if(k in data)data[k]=Number(data[k])||0;data.id=id();data.createdAt=new Date().toISOString();try{if(v2ModeLocked()){if(!isV2WriteEnabled(Number(remoteRevision)))throw new Error('V2確認モードは読み取り専用です');if(!canUseV2Entry(type))throw new Error('この入力はまだV2保存に対応していません');const result=await commitV2Transaction(({purchases:'purchase',sales:'sale',openings:'opening'})[type],v2EntryPayload(type,data));const check=acceptanceSnapshot(result.payload);if(!check.ok)throw new Error(`保存後の受入チェック失敗: ${check.issues.join(', ')}`);const projected=applyV2ReadOnlyToUi(state,{state:(await import('../v2/view-model.js')).v2ViewModel(result.payload),assets:check.assets,realizedProfit:check.realizedProfit,revision:result.revision,lastMutationId:result.lastMutationId});state=projected.state;v2AssetsCache=projected.assets;v2ProfitCache=projected.realizedProfit;remoteRevision=String(projected.revision);advanceV2WriteRevision(Number(remoteRevision));document.querySelector('#entry-dialog').close();render();setSyncStatus(`V2保存確認済み · rev ${projected.revision} · 書込継続中`,'success');toast('V2へ保存・再確認しました');return}if(type==='purchases')state=applyPurchase(state,data);else if(type==='sales')state=applySale(state,data);else if(type==='openings')state=applyOpening(state,data);else state[type].unshift(data);save(state);document.querySelector('#entry-dialog').close();render();toast('保存しました')}catch(err){setSyncStatus('V2保存失敗 · '+String(err.message||err),'warning');toast('V2保存失敗・未反映');alert(err.message)}finally{entrySubmitting=false}});
addEventListener('hashchange',()=>{const [next,param]=location.hash.slice(1).split('/');route=next||'dashboard';if(route==='inventory')subtype=['boxes','packs','cards'].includes(param)?param:'boxes';if(route==='ledger'&&param)subtype=param;render()});
document.querySelector('#today-label').textContent=dateFmt.format(new Date());render();
let v2ReconnectTimer=null,v2ReconnectBusy=false,v2ReconnectQueued=false,v2ReconnectAttempt=0,v2LastSuccessAt=0;
const v2ReconnectDelay_=()=>[2000,5000,10000,20000,30000][Math.min(v2ReconnectAttempt,4)];
function scheduleV2Reconnect_(){
 if(v2ReconnectTimer||!hasV2ReadOnly())return;
 const delay=v2ReconnectDelay_();
 v2ReconnectTimer=setTimeout(()=>{v2ReconnectTimer=null;connectV2Remote_()},delay);
}
async function connectV2Remote_(manual=false){
 if(v2ReconnectBusy){if(manual){v2ReconnectQueued=true;setSyncStatus('V2接続確認中…')}return false}
 if(!hasV2ReadOnly()){
  v2ReadOnly=true;remoteRevision='';render();
  setSyncStatus('V2接続情報の再確認が必要です。V1/ローカルデータは使用しません','warning');
  return false;
 }
 const hadConnection=v2Connected();
 v2ReconnectBusy=true;v2ReadOnly=true;
 if(!hadConnection)render();
 setSyncStatus(manual?'V2を再確認中…':'V2へ自動再接続中…');
 try{
  const snapshot=await tryLoadV2ReadOnly(),check=acceptanceSnapshot(snapshot.canonical);
  if(!check.ok)throw new Error(`V2受入チェック失敗: ${check.issues.join(', ')}`);
  const applied=applyV2ReadOnlyToUi(state,snapshot);
  if(!applied.active)throw new Error('V2正本を画面へ反映できませんでした');
  state=applied.state;v2ReadOnly=true;v2AssetsCache=applied.assets;v2ProfitCache=applied.realizedProfit;v2AutomationHealth=applied.automationHealth||{};remoteRevision=String(applied.revision??'');
  v2ReconnectAttempt=0;v2LastSuccessAt=Date.now();
  if(v2ReconnectTimer){clearTimeout(v2ReconnectTimer);v2ReconnectTimer=null}
  render();
  setSyncStatus(`V2確認OK · rev ${applied.revision} · 取引${check.counts.transactions}件 · 在庫${check.counts.inventoryQuantity}点`,'success');
  return true;
 }catch(err){
  console.warn('V2読込に失敗しました',err);
  if(!hadConnection){remoteRevision='';v2AssetsCache=null;v2ProfitCache=null;v2AutomationHealth={};state=emptyState();render()}
  v2ReconnectAttempt++;
  const seconds=Math.round(v2ReconnectDelay_()/1000);
  const reason=String(err&&err.message||err||'読込失敗').slice(0,180);
  setSyncStatus(hadConnection?`V2更新待ち: ${reason} · 表示中のV2データを維持して再試行します`:`V2一時切断: ${reason} · ${seconds}秒後に自動再接続します`,'warning');
  scheduleV2Reconnect_();
  return false;
 }finally{v2ReconnectBusy=false;if(v2ReconnectQueued){v2ReconnectQueued=false;setTimeout(()=>connectV2Remote_(),250)}}
}
async function bootRemote(){if(v2ModeLocked())v2ReadOnly=true;await connectV2Remote_()}
bootRemote();
const refreshV2OnResume_=()=>{if(!v2Connected()||Date.now()-v2LastSuccessAt>60000)connectV2Remote_()};
addEventListener('online',refreshV2OnResume_);
addEventListener('pageshow',refreshV2OnResume_);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshV2OnResume_()});
if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
