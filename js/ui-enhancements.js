import{transactionBreakdown,transactionKind,marketCheckedDate}from'./presentation.js';

const KEY='toreca-vault:v1';
const readState=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{}}};
const escRx=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const injectStyles=()=>{if(document.querySelector('#transaction-presentation-styles'))return;const style=document.createElement('style');style.id='transaction-presentation-styles';style.textContent=`
.list-item.txn-purchase{border-left:4px solid #74a9ff}.list-item.txn-sale{border-left:4px solid var(--accent)}
.list-item.txn-purchase .amount{color:#9cc2ff}.list-item.txn-sale .amount{color:#89f1ca}
.transaction-label{display:block;font-size:.68rem;font-weight:800;margin-bottom:2px}.transaction-breakdown{display:block;margin-top:3px;color:var(--muted);font-size:.7rem;font-weight:650;white-space:nowrap}
.market-checked-label{color:var(--muted);font-weight:700}
`;document.head.append(style)};
const currentLedgerRows=state=>{const months=[...new Set([...(state.purchases||[]),...(state.sales||[])].map(x=>(x.date||'').slice(0,7)).filter(Boolean))].sort().reverse();const active=document.querySelector('.month-tabs .tab.active')?.dataset.month||months[0]||'';return[...(state.purchases||[]).filter(x=>(x.date||'').startsWith(active)).map(x=>({...x,_kind:'purchases'})),...(state.sales||[]).filter(x=>(x.date||'').startsWith(active)).map(x=>({...x,_kind:'sales'}))].sort((a,b)=>(b.date||'').localeCompare(a.date||''))};
function decorateLedger(state){if(!location.hash.startsWith('#ledger')||v2Active())return;const rows=currentLedgerRows(state),nodes=[...document.querySelectorAll('#view>.list .list-item')];nodes.forEach((node,i)=>{const item=rows[i];if(!item)return;const kind=transactionKind(item._kind),breakdown=transactionBreakdown(item),amount=node.querySelector('.amount');node.classList.remove('txn-purchase','txn-sale');if(kind)node.classList.add(`txn-${kind}`);if(!amount)return;const html=`<span class="transaction-label">${kind==='sale'?'売却合計':'購入合計'}</span>${breakdown.total.toLocaleString('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0})}${breakdown.showBreakdown?`<small class="transaction-breakdown">${breakdown.text}</small>`:''}`;if(amount.innerHTML!==html)amount.innerHTML=html})}
function decorateCardDates(state){if(!location.hash.startsWith('#inventory/cards')||v2Active())return;const cards=(state.cards||[]).filter(x=>Number(x.quantity)>0),nodes=[...document.querySelectorAll('#view .list-item')];nodes.forEach((node,i)=>{const item=cards[i],meta=node.querySelector('.list-meta');if(!item||!meta)return;const checked=marketCheckedDate(item);if(!checked)return;const raw=String(item.marketCheckedAt||'');if(raw&&meta.textContent.includes(`(${raw})`))meta.textContent=meta.textContent.replace(new RegExp(`\\s*\\(${escRx(raw)}\\)`),'');if(!meta.querySelector('.market-checked-label'))meta.insertAdjacentHTML('beforeend',` <span class="market-checked-label">· 相場取得日 ${checked}</span>`)})}
let scheduled=false;function apply(){scheduled=false;injectStyles();const state=readState();decorateLedger(state);decorateCardDates(state)}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(apply)}
new MutationObserver(schedule).observe(document.querySelector('#view'),{childList:true,subtree:true});addEventListener('hashchange',schedule);schedule();
