import{franchiseOf,FRANCHISES}from'./franchise.js';

const KEY='toreca-vault:v1';
const yen=new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0});
const amount=x=>(+x.total||(+x.price||0)*(+x.quantity||1));
const saleRevenue=x=>(+x.price||0)*(x.quantity==null?1:+x.quantity||0)-(+x.fee||0);

function currentState(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{}}}
function currentMonth(){return document.querySelector('.month-tabs .tab.active')?.textContent?.trim()||''}
function renderFranchiseBreakdown(){
  if(location.hash.split('/')[0]!=='#ledger')return;
  const view=document.querySelector('#view'),month=currentMonth();if(!view||!month)return;
  const state=currentState(),p=(state.purchases||[]).filter(x=>(x.date||'').startsWith(month)),s=(state.sales||[]).filter(x=>(x.date||'').startsWith(month));
  const rows=FRANCHISES.map(name=>{const purchases=p.filter(x=>franchiseOf(x)===name),sales=s.filter(x=>franchiseOf(x)===name),spent=purchases.reduce((n,x)=>n+amount(x),0),revenue=sales.reduce((n,x)=>n+saleRevenue(x),0),known=sales.filter(x=>x.acquisitionCost!=null),cost=known.reduce((n,x)=>n+(+x.acquisitionCost||0),0),profit=known.reduce((n,x)=>n+saleRevenue(x)-(+x.acquisitionCost||0),0),pending=sales.length-known.length;return{name,spent,revenue,profit,pending}});
  let section=document.querySelector('#franchise-breakdown');if(!section){section=document.createElement('section');section.id='franchise-breakdown';const category=document.querySelector('.finance-breakdown')?.closest('section');(category||view.firstElementChild)?.insertAdjacentElement('afterend',section)}
  section.innerHTML=`<div class="section-head"><h2>作品別内訳</h2><span>最終収支は全作品合算</span></div><div class="panel finance-breakdown">${rows.map(r=>`<div><b>${r.name}</b><span>購入 ${yen.format(r.spent)}</span><span>売却 ${yen.format(r.revenue)}</span><span>実現損益 ${r.profit>=0?'+':''}${yen.format(r.profit)}${r.pending?`（原価未確定 ${r.pending}件）`:''}</span></div>`).join('')}</div>`;
}

// 新規の購入・売却は商品名から作品区分を保存する。必要なら将来手動上書きも可能。
document.addEventListener('submit',e=>{if(e.target?.id!=='entry-form')return;const type=e.target.dataset.type;if(!['purchases','sales'].includes(type))return;let hidden=e.target.querySelector('input[name="franchise"]');if(!hidden){hidden=document.createElement('input');hidden.type='hidden';hidden.name='franchise';e.target.append(hidden)}hidden.value=franchiseOf({product:e.target.querySelector('[name="product"]')?.value||''})},true);

const observer=new MutationObserver(()=>queueMicrotask(renderFranchiseBreakdown));observer.observe(document.querySelector('#view'),{childList:true,subtree:true});
addEventListener('hashchange',()=>queueMicrotask(renderFranchiseBreakdown));
queueMicrotask(renderFranchiseBreakdown);
