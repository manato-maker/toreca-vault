const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const jstDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function known(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}
function money(value) { return yen.format(num(value)); }
function date(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function category(lot) {
  return ['BOX', 'パック', 'カード'].includes(lot.category) ? lot.category : 'その他';
}
function quoteIndex(quotes) {
  const byLot = new Map(), byKey = new Map();
  for (const q of quotes) {
    if (q?.lotId) byLot.set(String(q.lotId), q);
    else if (q) byKey.set([String(q.productKey || q.product || '').trim().toLocaleLowerCase('ja'), String(q.condition || '')].join('::'), q);
  }
  return { byLot, byKey };
}
function quoteFor(index, lot) {
  return index.byLot.get(String(lot.id || '')) ||
    index.byKey.get([String(lot.productKey || lot.product || '').trim().toLocaleLowerCase('ja'), String(lot.condition || '')].join('::'));
}
function eventsFor(lotteries) {
  const events = [];
  for (const lottery of lotteries) {
    const label = String(lottery.title || lottery.product || lottery.store || '抽選予定');
    for (const [field, kind] of [['deadline', '応募締切'], ['resultDate', '結果発表'], ['receiveDeadline', '購入期限']]) {
      const value = date(lottery[field]);
      if (value) events.push({ date: value, kind, label, store: String(lottery.store || ''), status: String(lottery.status || '') });
    }
    if (Array.isArray(lottery.resultDates)) {
      for (const result of lottery.resultDates) {
        const value = date(typeof result === 'string' ? result : result?.date);
        if (value) events.push({ date: value, kind: '結果発表', label, store: String(lottery.store || ''), status: String(lottery.status || '') });
      }
    }
  }
  const seen = new Set();
  return events.filter(e => {
    const key = [e.date, e.kind, e.label, e.store].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}
function calendar(month, events, today) {
  const parts = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  const current = parts ? month : today.slice(0, 7);
  const [year, m] = current.split('-').map(Number);
  const start = new Date(Date.UTC(year, m - 1, 1));
  const offset = start.getUTCDay();
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const byDate = new Map();
  for (const event of events) byDate.set(event.date, (byDate.get(event.date) || 0) + 1);
  const grid = [];
  for (let i = 0; i < Math.ceil((offset + days) / 7) * 7; i++) {
    const day = i - offset + 1;
    if (day < 1 || day > days) { grid.push('<span class="day muted"></span>'); continue; }
    const d = current + '-' + String(day).padStart(2, '0');
    const count = byDate.get(d) || 0;
    grid.push('<span class="day' + (today === d ? ' is-today' : '') + '"><span>' + day + '</span>' +
      (count ? '<small>' + (count > 9 ? '9+' : count) + '件</small>' : '') + '</span>');
  }
  const prev = new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 7);
  return '<div class="calendar-head"><a aria-label="前月" href="/app?month=' + prev + '#calendar">‹</a><strong>' + esc(year) + '年' + esc(m) + '月</strong><a aria-label="翌月" href="/app?month=' + next + '#calendar">›</a></div>' +
    '<div class="calendar-grid">' + ['日','月','火','水','木','金','土'].map((s,i) => '<span class="weekday w'+i+'">' + s + '</span>').join('') +
    grid.join('') + '</div>';
}
function inventoryCard(lot, quote) {
  const n = num(lot.quantity);
  const c = category(lot);
  const priceOK = quote && known(quote.price) && num(quote.price) > 0 &&
    (c !== 'カード' || /^(?:カードラッシュ|トレトク)/.test(String(quote.source || '')));
  const priceLabel = priceOK ? money(quote.price) : '価格未取得';
  const source = priceOK ? (quote.fresh === false ? '前回取得（要更新）' : '参考相場') : '相場確認待ち';
  return '<div class="stock-row"><div class="stock-main"><div class="stock-name">' + esc(lot.product || lot.productKey || '商品名未設定') +
    '</div><div class="stock-meta"><span class="pill">' + esc(c) + '</span>' + (lot.condition ? '<span>' + esc(lot.condition) + '</span>' : '') +
    (lot.acquiredAt ? '<span>' + esc(date(lot.acquiredAt)) + '</span>' : '') + '</div></div>' +
    '<div class="stock-money"><b>' + esc(n) + '点</b><span>' + esc(priceLabel) + ' / 点</span><small>' + source +
    (known(lot.unitCost) ? ' · 原価 ' + esc(money(lot.unitCost)) : ' · 原価未設定') + '</small></div></div>';
}

export function renderDashboard(snapshot, revision, monthOverride = '', now = new Date(), historyType = 'all', handoverDocId = '') {
  if (!snapshot || Number(snapshot.schemaVersion) !== 2) throw new Error('invalid snapshot');
  const lots = Array.isArray(snapshot.inventoryLots) ? snapshot.inventoryLots.filter(l => num(l?.quantity) > 0) : [];
  const transactions = Array.isArray(snapshot.transactions) ? snapshot.transactions : [];
  const lotteries = Array.isArray(snapshot.lotteries) ? snapshot.lotteries : [];
  const quotes = quoteIndex(Array.isArray(snapshot.marketQuotes) ? snapshot.marketQuotes : []);
  let cost = 0, assetEstimate = 0, noPrice = 0, unknownCost = 0;
  const categoryTotals = { 'BOX': 0, 'パック': 0, 'カード': 0 };
  for (const lot of lots) {
    const quantity = num(lot.quantity), kind = category(lot);
    categoryTotals[kind] = (categoryTotals[kind] || 0) + quantity;
    if (known(lot.unitCost)) cost += num(lot.unitCost) * quantity;
    else unknownCost += quantity;
    const quote = quoteFor(quotes, lot);
    const acceptedPrice = quote && known(quote.price) && num(quote.price) > 0 &&
      (kind !== 'カード' || /^(?:カードラッシュ|トレトク)/.test(String(quote.source || '')));
    if (acceptedPrice) assetEstimate += num(quote.price) * quantity;
    else {
      noPrice += quantity;
      if (kind !== 'カード' && known(lot.unitCost)) assetEstimate += num(lot.unitCost) * quantity;
    }
  }
  const sales = transactions.filter(t => t.type === 'sale');
  const knownSales = sales.filter(t => known(t.acquisitionCost));
  const realized = knownSales.reduce((sum, t) => sum + num(t.price) * num(t.quantity) - num(t.fee) - num(t.acquisitionCost), 0);
  const stockQty = lots.reduce((n, lot) => n + num(lot.quantity), 0);
  const today = jstDate.format(now);
  const month = /^20\d{2}-(0[1-9]|1[0-2])$/.test(monthOverride) ? monthOverride : today.slice(0, 7);
  const events = eventsFor(lotteries);
  const relevantEvents = events.filter(e => e.date.slice(0, 7) === month).slice(0, 30);
  // Keep the overview short; category-specific views must not hide older sales.
  const types = ['all', 'purchase', 'sale', 'opening'];
  const selectedType = types.includes(historyType) ? historyType : 'all';
  const sorted = [...transactions].sort((a,b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.id || '').localeCompare(String(a.id || '')));
  const visibleTransactions = selectedType === 'all'
    ? sorted.slice(0, 12)
    : sorted.filter(t => t.type === selectedType);
  const counts = Object.fromEntries(types.map(type => [
    type, type === 'all' ? transactions.length : transactions.filter(t => t.type === type).length
  ]));
  const historyFilters = '<nav class="history-filters" aria-label="取引履歴の絞り込み">' +
    [['all','すべて'], ['purchase','購入'], ['sale','売却'], ['opening','開封']]
      .map(([type,label]) => '<a class="history-filter' + (selectedType === type ? ' selected' : '') +
        '" href="/app?month=' + month + '&type=' + type + '#history"' +
        (selectedType === type ? ' aria-current="page"' : '') + '>' +
        label + ' ' + counts[type] + '</a>').join('') + '</nav>';
  const historyCountLabel = selectedType === 'all'
    ? counts.all + '件中 直近' + visibleTransactions.length + '件'
    : counts[selectedType] + '件すべて';
  const metric = (name, value, sub) => '<div class="metric"><div>' + esc(name) + '</div><strong>' + esc(value) + '</strong><small>' + esc(sub) + '</small></div>';
  const rows = [...lots].sort((a,b) => String(b.acquiredAt || '').localeCompare(String(a.acquiredAt || ''))).slice(0, 80);
  const eventRows = relevantEvents.length ? relevantEvents.map(e =>
    '<div class="event"><span class="event-date">' + esc(e.date.slice(5).replace('-', '/')) +
    '</span><span class="event-kind">' + esc(e.kind) + '</span><span class="event-description">' +
    esc(e.label) + (e.store ? '<small>' + esc(e.store) + '</small>' : '') + '</span></div>').join('')
    : '<p class="empty">この月の登録済み予定はありません。</p>';
  const transactionRows = visibleTransactions.length ? visibleTransactions.map(t => {
    const kind = t.type === 'sale' ? '売却' : t.type === 'purchase' ? '購入' : '開封';
    const amount = t.type === 'sale'
      ? num(t.price) * num(t.quantity) - num(t.fee)
      : known(t.total) ? num(t.total) : num(t.price) * num(t.quantity);
    const profit = t.type === 'sale' && known(t.acquisitionCost) ? amount - num(t.acquisitionCost) : null;
    return '<div class="history-row"><div><b>' + esc(t.product || t.productKey || '取引') +
      '</b><small>' + esc(date(t.date) || '日付未設定') + ' · ' + esc(t.store || '') + '</small></div>' +
      '<div class="history-money"><span class="' + (t.type === 'sale' ? 'positive' : '') + '">' +
      esc(kind) + ' · ' + esc(money(amount)) + '</span>' +
      (profit !== null ? '<small>確定利益 ' + esc(money(profit)) + '</small>' :
        t.type === 'sale' ? '<small>原価未確認</small>' : '') + '</div></div>';
  }).join('') : '<p class="empty">この種別の取引記録はありません。</p>';
  // The Google Docs document is the single private handover source. Export on
  // click, rather than caching or copying sensitive text into Firestore or GitHub.
  const validHandoverId = typeof handoverDocId === 'string' &&
    /^[A-Za-z0-9_-]{20,120}$/.test(handoverDocId) ? handoverDocId : '';
  const handoverBase = validHandoverId
    ? 'https://docs.google.com/document/d/' + validHandoverId : '';
  const handoverSection = handoverBase
    ? '<section class="panel" id="handover"><div class="panel-top"><h2>引き継ぎ</h2><span class="minor">Chat / Work 共通</span></div>' +
      '<p class="meta">共通正本はGoogle Docsに保存されています。更新後は、リンクを開くかダウンロードするとその時点の内容を取得できます。</p>' +
      '<div class="handover-actions"><a class="btn" href="' + handoverBase + '/edit" target="_blank" rel="noopener noreferrer">最新版を開く</a>' +
      '<a class="btn" href="' + handoverBase + '/export?format=txt" target="_blank" rel="noopener noreferrer">引き継ぎをダウンロード (.txt)</a></div>' +
      '<p class="meta">Googleアカウントで文書の閲覧権限が必要です。ダウンロードしたファイルは機密情報として扱ってください。ここからは編集・自動登録しません。</p></section>'
    : '';
  const css = `
:root{color-scheme:dark;--bg:#0b1220;--card:#151f31;--line:#29394e;--txt:#edf5ff;--muted:#93a5bc;--aqua:#70e4d2;--purple:#9888ff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",system-ui,sans-serif;font-size:14px;line-height:1.5}
a{color:inherit;text-decoration:none}main{max-width:1040px;margin:auto;padding:18px 16px 108px}header{max-width:1040px;margin:auto;padding:24px 16px 8px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:12px;font-weight:750;font-size:20px}.brand-mark{background:linear-gradient(135deg,var(--aqua),#737cff);color:#10182a;padding:10px;border-radius:14px;font-weight:900}.tag{font-size:10px;letter-spacing:.12em;border:1px solid var(--line);border-radius:12px;padding:5px 8px;color:var(--muted)}
.meta{color:var(--muted);font-size:12px}.intro{padding:17px 2px 21px}h1{font-size:26px;letter-spacing:-.04em;margin:4px 0 7px}h2{font-size:19px;margin:0 0 16px}p{margin:0}.kicker{color:var(--aqua);font-size:11px;letter-spacing:.14em;font-weight:700}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.metric,.panel{background:var(--card);border:1px solid var(--line);border-radius:17px}.metric{padding:18px 15px;min-width:0}.metric>div,.metric small{color:var(--muted);font-size:11px}.metric strong{display:block;font-size:clamp(17px,5vw,30px);letter-spacing:-.04em;margin:7px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric small{display:block}
.panel{padding:18px;margin-top:18px;scroll-margin-top:16px}.panel-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.panel-top h2{margin:0}.minor{font-size:12px;color:var(--muted)}
.warning{border:1px solid #5c4d39;background:#29261f;color:#f7d79f;border-radius:10px;padding:12px;margin-top:14px;font-size:12px}.stock-row,.event,.history-row{display:flex;justify-content:space-between;gap:10px;padding:13px 0;border-bottom:1px solid var(--line)}.stock-row:last-child,.event:last-child,.history-row:last-child{border:0}
.stock-main{min-width:0;flex:1}.stock-name{font-weight:700;overflow-wrap:anywhere}.stock-meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;color:var(--muted);font-size:11px;margin-top:6px}.pill{background:#25423f;color:var(--aqua);padding:3px 8px;border-radius:50px}.stock-money{display:flex;flex-direction:column;gap:2px;text-align:right;min-width:106px}.stock-money span{color:var(--txt);font-size:12px}.stock-money small{color:var(--muted);font-size:10px}
.calendar-head{display:flex;justify-content:space-between;align-items:center;margin:18px 0}.calendar-head a{background:#24344b;border-radius:10px;padding:5px 14px;font-size:24px}.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}.weekday{text-align:center;color:var(--muted);font-size:11px;padding:5px}.w0{color:#ff9f9f}.w6{color:#a6afff}.day{min-height:50px;border-radius:9px;background:#1e2a3d;padding:7px;display:flex;flex-direction:column;gap:3px;align-items:flex-start}.day.muted{background:transparent}.day.is-today{outline:2px solid var(--aqua)}.day small{color:var(--aqua);font-size:10px}
.history-filters{display:flex;gap:8px;overflow-x:auto;padding:9px 0 13px;scrollbar-width:thin}.history-filter{white-space:nowrap;border:1px solid var(--line);padding:9px 12px;background:#213047;border-radius:12px;color:var(--txt);font-size:12px;min-width:64px;text-align:center}.history-filter.selected{background:#24504d;color:var(--aqua);border-color:var(--aqua);font-weight:700}.history-money{min-width:110px;display:flex;flex-direction:column;gap:4px;align-items:flex-end;text-align:right}.history-money span{font-size:12px;white-space:nowrap}.history-money small{color:var(--muted);font-size:11px}.event{align-items:center;justify-content:flex-start}.event-date{font-weight:750;color:var(--aqua);min-width:45px}.event-kind{font-size:11px;color:var(--muted);min-width:58px}.event-description{overflow-wrap:anywhere}.event-description small{display:block;color:var(--muted)}.history-row{align-items:center}.history-row b{display:block;overflow-wrap:anywhere}.history-row small{display:block;color:var(--muted);font-size:11px}.history-row>span{white-space:nowrap;font-size:12px}.positive{color:var(--aqua)}.empty{color:var(--muted);padding:15px 0}
.bottom{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;background:#101b2deb;backdrop-filter:blur(16px);border-top:1px solid var(--line);padding:11px 6px max(17px,env(safe-area-inset-bottom));z-index:3}.bottom a{text-align:center;font-size:12px;min-width:60px;color:#e6effe}.bottom span{display:block;font-size:20px;color:var(--aqua)}
footer{padding:30px 0;color:var(--muted);font-size:11px;text-align:center}.btn{background:#27433f;color:var(--aqua);font-size:12px;padding:10px 12px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}.btn:focus-visible{outline:2px solid var(--aqua);outline-offset:2px}.handover-actions{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0}
@media(min-width:750px){.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}main{padding-bottom:60px}.bottom{position:static;max-width:1040px;margin:auto;border:1px solid var(--line);border-radius:15px 15px 0 0}.day{min-height:80px}}
@media(max-width:380px){.stock-money{min-width:88px}.day{padding:4px}.metric{padding:12px}.metric strong{font-size:18px}}
`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220"><title>Toreca Vault · ステージング</title><style>${css}</style></head><body>
<header><div class="brand"><span class="brand-mark">TV</span><span>Toreca Vault</span></div><span class="tag">STAGING · 閲覧専用</span></header>
<main id="top"><section class="intro"><div class="kicker">ASSET DASHBOARD</div><h1>資産ダッシュボード</h1>
<p class="meta">更新 ${esc(today)} · V2 revision ${esc(revision)}</p></section>
<div class="metrics">
${metric('参考資産額',money(assetEstimate),'一部は原価を代用・未取得価格を含む')}
${metric('在庫原価',money(cost),unknownCost ? '原価不明 ' + unknownCost + '点' : '既知の取得原価合計')}
${metric('参考評価差額',money(assetEstimate - cost),'相場欠落時は厳密な含み益ではありません')}
${metric('確定売却益',money(realized),knownSales.length + '/' + sales.length + '件の原価確認済み売却')}
${metric('保有点数',stockQty + '点','BOX ' + categoryTotals.BOX + ' / パック ' + categoryTotals['パック'] + ' / カード ' + categoryTotals['カード'])}
${metric('相場未取得',noPrice + '点','更新されていない相場も要確認')}
</div>
<div class="warning">この画面は新アプリのステージング環境です。本番V2とは独立しており、表示値はステージングの保存データに基づきます。参考資産額は相場未取得のBOX・パックを原価で代用し、カードの未取得価格は0円として集計しています。</div>
<section class="panel" id="inventory"><div class="panel-top"><h2>在庫一覧</h2><span class="minor">${lots.length}ロット</span></div>
${rows.length ? rows.map(l => inventoryCard(l, quoteFor(quotes,l))).join('') : '<p class="empty">在庫がありません。</p>'}
</section>
<section class="panel" id="calendar"><div class="panel-top"><h2>予定カレンダー</h2><span class="minor">抽選・購入期限</span></div>
${calendar(month,events,today)}<h2 style="margin-top:23px">${esc(month)} の予定</h2>${eventRows}
</section>
<section class="panel" id="history"><div class="panel-top"><h2>取引履歴</h2><span class="minor">${historyCountLabel}</span></div>${historyFilters}${transactionRows}</section>
${handoverSection}
<footer>読み取り専用 · Toreca Vault staging · データの登録・修正はできません</footer>
</main>
<nav class="bottom" aria-label="ページ内メニュー"><a href="#top" aria-label="上部へ"><span>⌂</span>資産</a><a href="#inventory"><span>▤</span>在庫</a><a href="#calendar"><span>▦</span>予定</a><a href="#history"><span>↗</span>履歴</a>${handoverSection ? '<a href="#handover"><span>☷</span>引継ぎ</a>' : ''}</nav></body></html>`;
}
