const config=window.TV2_APP_CONFIG||{};
const money=new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0});
const dayFmt=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short'});
const state={credential:'',data:null,filter:'all',view:'assets'};
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function dateToday(){return dayFmt.format(new Date())}
function setStatus(text,isError=false){$('status').textContent=text;$('status').classList.toggle('error',isError)}
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600)}
function showDashboard(){ $('login').hidden=true;$('dashboard').hidden=false;$('bottom-nav').hidden=false }
function showLogin(message=''){ $('login').hidden=false;$('dashboard').hidden=true;$('bottom-nav').hidden=true;if(message)$('login-message').textContent=message }
function renderSummary(summary){
 $('total-assets').textContent=money.format(summary.assets.total);
 $('asset-difference').textContent='現在庫取得原価との差額 '+(summary.assets.difference>=0?'+':'')+money.format(summary.assets.difference);
 $('asset-difference').classList.toggle('negative',summary.assets.difference<0);
 $('realized-profit').textContent=(summary.realizedProfit>=0?'+':'')+money.format(summary.realizedProfit);
 $('inventory-cost').textContent=money.format(summary.assets.inventoryCost);
 $('cards-value').textContent=money.format(summary.assets.cards);
 $('boxes-value').textContent=money.format(summary.assets.boxes);
 $('packs-value').textContent=money.format(summary.assets.packs);
 $('purchases-total').textContent=money.format(summary.assets.purchases);
 $('sales-total').textContent=money.format(summary.assets.sales);
 $('revision').textContent=String(summary.revision);
}
function renderInventory(){
 const all=state.data?.inventory||[];
 const filtered=state.filter==='all'?all:all.filter(row=>row.category===state.filter);
 $('stock-count').textContent=filtered.length+'種類';
 if(!filtered.length){$('inventory-list').innerHTML='<div class="empty-state">この種別の在庫はありません</div>';return}
 $('inventory-list').innerHTML=filtered.map(row=>{
   const price=row.marketPrice==null?'価格未取得':money.format(row.marketPrice)+' / 個';
   const cost=row.unitCost==null?'原価要確認':money.format(row.unitCost)+' / 個';
   return '<article class="stock-card"><div class="stock-top"><div class="stock-name">'+esc(row.product+(row.set?' · '+row.set:''))+'</div><div class="stock-qty">× '+esc(row.quantity)+'</div></div><div class="stock-meta"><span class="pill">'+esc(row.category)+'</span><span class="pill">'+esc(row.condition||'状態未設定')+'</span>'+(row.identityNeedsReview?'<span class="pill">要確認</span>':'')+'</div><div class="stock-bottom"><span>取得原価 '+esc(cost)+'</span><span>'+esc(price)+'</span></div></article>'
 }).join('');
}
function renderView(){
 document.querySelectorAll('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===state.view));
 const inventorySection=document.querySelector('.inventory-section');
 const metrics=document.querySelector('.metric-grid');
 const heroes=document.querySelectorAll('.hero-card');
 if(state.view==='inventory'){
   heroes.forEach(element=>element.hidden=true);metrics.hidden=true;inventorySection.hidden=false;
   window.scrollTo({top:0,behavior:'smooth'});
 }else if(state.view==='income'){
   heroes.forEach(element=>element.hidden=element.classList.contains('hero-card')&&!element.classList.contains('profit-card'));
   metrics.hidden=false;inventorySection.hidden=true;window.scrollTo({top:0,behavior:'smooth'});
 }else if(state.view==='activity'){
   heroes.forEach(element=>element.hidden=true);metrics.hidden=true;inventorySection.hidden=false;
   inventorySection.querySelector('h2').textContent='在庫の更新';
   inventorySection.querySelector('.eyebrow').textContent='LATEST SNAPSHOT';
   window.scrollTo({top:0,behavior:'smooth'});
 }else{
   heroes.forEach(element=>element.hidden=false);metrics.hidden=false;inventorySection.hidden=false;
   inventorySection.querySelector('h2').textContent='在庫';
   inventorySection.querySelector('.eyebrow').textContent='CURRENT STOCK';
 }
}
async function loadData(credential=state.credential){
 if(!credential)return;
 setStatus('在庫を読み込み中…');
 try{
  const response=await fetch('/api/v2/dashboard',{headers:{authorization:'Bearer '+credential},cache:'no-store'});
  const result=await response.json();
  if(response.status===401||response.status===403){state.credential='';showLogin('ログインを確認できません。もう一度Googleアカウントでログインしてください。');return}
  if(!response.ok||!result.ok)throw new Error(result.error||'読み込みに失敗しました');
  state.data=result;state.credential=credential;renderSummary(result);renderInventory();showDashboard();
  const updated=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}).format(new Date(result.updatedAt));
  setStatus('最終更新 '+updated+' · staging');
 }catch(error){setStatus(error.message||'読み込みに失敗しました',true);toast('在庫を読み込めませんでした')}
}
function initializeGoogle(){
 if(!config.googleClientId){showLogin('Googleログイン設定がまだ完了していません。');return}
 if(!window.google?.accounts?.id){setTimeout(initializeGoogle,250);return}
 google.accounts.id.initialize({client_id:config.googleClientId,callback:async response=>{if(response?.credential)await loadData(response.credential)}});
 google.accounts.id.renderButton($('google-signin'),{type:'standard',theme:'filled_black',size:'large',shape:'pill',text:'signin_with',width:260});
}
$('today').textContent=dateToday();
$('refresh').addEventListener('click',()=>loadData());
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));renderInventory()}));
document.querySelectorAll('.nav-item').forEach(button=>button.addEventListener('click',()=>{state.view=button.dataset.view;renderView()}));
initializeGoogle();
