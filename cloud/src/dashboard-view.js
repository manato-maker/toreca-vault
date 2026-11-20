import { buybackForLot, buybackOffersForLot, buybackSourceUrl, buybackTimestamp } from './buyback-quotes.js';

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
function calendar(month, events, today, selectedDate = '') {
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
    const active = selectedDate === d;
    const classes = 'day' + (today === d ? ' is-today' : '') + (active ? ' is-selected' : '');
    grid.push('<a class="' + classes + '" href="/app?view=calendar&month=' + current + '&date=' + d + '#event-list" aria-label="' + d + ' の予定を表示" aria-describedby="event-list"' +
      (active ? ' aria-current="date"' : '') + '><span>' + day + '</span>' +
      (count ? '<small>' + (count > 9 ? '9+' : count) + '件</small>' : '') + '</a>');
  }
  const prev = new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 7);
  return '<div class="calendar-head"><a aria-label="前月" href="/app?view=calendar&month=' + prev + '#calendar">‹</a><strong>' + esc(year) + '年' + esc(m) + '月</strong><a aria-label="翌月" href="/app?view=calendar&month=' + next + '#calendar">›</a></div>' +
    '<div class="calendar-grid">' + ['日','月','火','水','木','金','土'].map((s,i) => '<span class="weekday w'+i+'">' + s + '</span>').join('') +
    grid.join('') + '</div>';
}
function categoryIcon(kind) {
  if (kind === 'BOX') return '<svg viewBox="0 0 48 56" aria-hidden="true" focusable="false"><path d="M8 4h23l8 8v40H8z"/><path d="M31 4v9h8M8 17h31M14 25h17M14 31h20M14 37h14"/></svg>';
  if (kind === 'パック') return '<svg viewBox="0 0 48 56" aria-hidden="true" focusable="false"><path d="m9 5 4 3h22l4-3 2 6v34l-2 6-4-3H13l-4 3-2-6V11z"/><path d="M14 17h20M14 39h20"/></svg>';
  if (kind === 'カード') return '<svg viewBox="0 0 48 56" aria-hidden="true" focusable="false"><rect x="9" y="4" width="30" height="48" rx="2"/><path d="M14 11h20v28H14zM18 45h12"/></svg>';
  return '<svg viewBox="0 0 48 56" aria-hidden="true" focusable="false"><circle cx="24" cy="28" r="17"/><path d="M7 28h34M24 11v34"/></svg>';
}
function inventoryCard(lot, picked, offers = []) {
  const n = num(lot.quantity);
  const c = category(lot);
  const active = picked.status === 'current';
  const stale = picked.status === 'stale';
  const priceLabel = active ? money(picked.price) : stale ? money(picked.price) + '（旧価格）' : '買取相場未取得';
  const shop = picked.quote ? String(picked.quote.sourceStore || picked.quote.source || '') : '';
  const quoteDate = buybackTimestamp(picked.quote);
  const sourceUrl = buybackSourceUrl(picked.quote);
  const source = active ? '参考買取価格' : stale ? '過去の買取提示額・要更新' : '買取相場確認待ち';
  const evidence = shop ? ' · ' + esc(shop) + (quoteDate ? ' (' + esc(quoteDate) + ')' : '') : '';
  const link = sourceUrl ? ' <a class="quote-link" href="' + esc(sourceUrl) + '" target="_blank" rel="noopener noreferrer">元投稿</a>' : '';
  const shopOffers = offers.length
    ? '<div class="shop-offers" aria-label="店舗別の有効な参考買取価格">' +
      offers.slice(0, 4).map(q => {
        const url = buybackSourceUrl(q);
        const shopName = esc(q.sourceStore || q.source || '店舗');
        const value = esc(money(q.buybackYen ?? q.price));
        const reference = url ? ' <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">出典</a>' : '';
        return '<span class="shop-offer">' + shopName + ' ' + value + reference + '</span>';
      }).join('') + '</div>' : '';
  return '<div class="stock-row" data-inventory-category="' + esc(c) + '"><div class="stock-main"><div class="stock-title"><span class="stock-icon" aria-label="' + esc(c) + 'のマーク">' + categoryIcon(c) + '</span><div class="stock-name">' + esc(lot.product || lot.productKey || '商品名未設定') +
    '</div></div><div class="stock-meta"><span class="pill">' + esc(c) + '</span>' + (lot.condition ? '<span>' + esc(lot.condition) + '</span>' : '') +
    (lot.acquiredAt ? '<span>' + esc(date(lot.acquiredAt)) + '</span>' : '') + '</div>' + shopOffers + '</div>' +
    '<div class="stock-money"><b>' + esc(n) + '点</b><span>' + esc(priceLabel) + ' / 点</span><small>' + source + evidence + link +
    (known(lot.unitCost) ? ' · 原価 ' + esc(money(lot.unitCost)) : ' · 原価未設定') + '</small></div></div>';
}

export function renderDashboard(snapshot, revision, monthOverride = '', now = new Date(), historyType = 'all', handoverDocId = '', dateOverride = '', viewOverride = '') {
  if (!snapshot || Number(snapshot.schemaVersion) !== 2) throw new Error('invalid snapshot');
  const lots = Array.isArray(snapshot.inventoryLots) ? snapshot.inventoryLots.filter(l => num(l?.quantity) > 0) : [];
  const transactions = Array.isArray(snapshot.transactions) ? snapshot.transactions : [];
  const lotteries = Array.isArray(snapshot.lotteries) ? snapshot.lotteries : [];
  const quotes = Array.isArray(snapshot.marketQuotes) ? snapshot.marketQuotes : [];
  let cost = 0, buybackTotal = 0, comparableBuyback = 0, comparableCost = 0, pricedCount = 0;
  let noPrice = 0, unknownCost = 0, comparableQuantity = 0;
  const categoryTotals = { 'BOX': 0, 'パック': 0, 'カード': 0 };
  const pickedByLot = new Map();
  const offersByLot = new Map();
  for (const lot of lots) {
    const quantity = num(lot.quantity), kind = category(lot);
    categoryTotals[kind] = (categoryTotals[kind] || 0) + quantity;
    if (known(lot.unitCost)) cost += num(lot.unitCost) * quantity;
    else unknownCost += quantity;
    const picked = buybackForLot(quotes, lot, now);
    pickedByLot.set(lot, picked);
    offersByLot.set(lot, buybackOffersForLot(quotes, lot, now));
    if (picked.status === 'current') {
      buybackTotal += picked.price * quantity;
      pricedCount += quantity;
      if (known(lot.unitCost)) {
        comparableBuyback += picked.price * quantity;
        comparableCost += num(lot.unitCost) * quantity;
        comparableQuantity += quantity;
      }
    } else noPrice += quantity;
  }
  const sales = transactions.filter(t => t.type === 'sale');
  const knownSales = sales.filter(t => known(t.acquisitionCost));
  const realized = knownSales.reduce((sum, t) => sum + num(t.price) * num(t.quantity) - num(t.fee) - num(t.acquisitionCost), 0);
  const stockQty = lots.reduce((n, lot) => n + num(lot.quantity), 0);
  const partiallyPriced = pricedCount < stockQty;
  const today = jstDate.format(now);
  const month = /^20\d{2}-(0[1-9]|1[0-2])$/.test(monthOverride) ? monthOverride : today.slice(0, 7);
  const events = eventsFor(lotteries);
  const unreceivedWinners = lotteries.filter(lottery =>
    ['当選', '購入済'].includes(String(lottery?.status || '')) && lottery?.receiptStatus === '未受取');
  const relevantEvents = events.filter(e => e.date.slice(0, 7) === month);
  // Keep the overview short; category-specific views must not hide older sales.
  const types = ['all', 'purchase', 'sale', 'opening'];
  const selectedType = types.includes(historyType) ? historyType : 'all';
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateOverride || '')) && String(dateOverride).slice(0, 7) === month
    ? String(dateOverride) : '';
  const views = ['assets', 'inventory', 'calendar', 'history', 'handover'];
  const selectedView = views.includes(viewOverride) ? viewOverride
    : selectedDate ? 'calendar'
      : historyType !== 'all' ? 'history'
        : monthOverride ? 'calendar' : 'assets';
  const pageTitles = {
    assets: '資産ダッシュボード',
    inventory: '在庫一覧',
    calendar: '予定カレンダー',
    history: '取引履歴',
    handover: '引き継ぎ'
  };
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
        '" href="/app?view=history&month=' + month + '&type=' + type + '#history"' +
        (selectedType === type ? ' aria-current="page"' : '') + '>' +
        label + ' ' + counts[type] + '</a>').join('') + '</nav>';
  const historyCountLabel = selectedType === 'all'
    ? counts.all + '件中 直近' + visibleTransactions.length + '件'
    : counts[selectedType] + '件すべて';
  const metric = (name, value, sub, href = '') => href
    ? '<a class="metric-link" href="' + esc(href) + '"><div class="metric"><div>' + esc(name) + '</div><strong>' + esc(value) + '</strong><small>' + esc(sub) + '</small></div></a>'
    : '<div class="metric"><div>' + esc(name) + '</div><strong>' + esc(value) + '</strong><small>' + esc(sub) + '</small></div>';
  const rows = [...lots].sort((a,b) => String(b.acquiredAt || '').localeCompare(String(a.acquiredAt || ''))).slice(0, 80);
  const displayedEvents = selectedDate ? relevantEvents.filter(e => e.date === selectedDate) : relevantEvents;
  const eventRows = displayedEvents.length ? displayedEvents.map(e =>
    '<div class="event"><span class="event-date">' + esc(e.date.slice(5).replace('-', '/')) +
    '</span><span class="event-kind">' + esc(e.kind) + '</span><span class="event-description">' +
    esc(e.label) + (e.store ? '<small>' + esc(e.store) + '</small>' : '') + '</span></div>').join('')
    : '<p class="empty">' + (selectedDate ? 'この日に登録済み予定はありません。' : 'この月の登録済み予定はありません。') + '</p>';
  const winningRows = unreceivedWinners.length
    ? unreceivedWinners.map(lottery => {
      const details = [];
      details.push(lottery.status === '購入済' ? '購入済・到着待ち' : '当選・未受取');
      if (date(lottery.resultDate)) details.push('結果発表 ' + date(lottery.resultDate));
      if (date(lottery.receiveDeadline)) details.push('受取期限 ' + date(lottery.receiveDeadline));
      return '<div class="winning-item"><div><b>' + esc(lottery.title || lottery.product || '商品名未設定') +
        '</b><small>' + esc(lottery.store || '店舗未登録') + '</small></div><span class="winning-detail">' +
        esc(details.join(' · ') || '受取期限未登録') + '</span></div>';
    }).join('')
    : '<p class="winning-empty">当選・未受取の商品はありません。</p>';
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
  // Both visible handoff actions use the shared Drive Markdown source.
  const handoverSection =
    '<section class="panel" id="handover"><div class="panel-top"><h2>引き継ぎ</h2><span class="minor">Chat / Work 共通</span></div>' +
    '<p class="meta">共通のMarkdown資料を使います。ダウンロード時にDriveから最新版を取得します。</p>' +
    '<div class="handover-actions"><a class="btn" href="/api/handoff/download" download="Toreca_Vault_Common_Handoff_2026-11-14.md">最新版をダウンロード (.md)</a>' +
    '<a class="btn" href="https://drive.google.com/file/d/1j8Mu-oz84zWFE-HPDhcT1_Ah22itSCo7/view" target="_blank" rel="noopener noreferrer">共通資料をDriveで開く</a></div>' +
    '<p class="meta">画面下部の「引継ぎ」からこの案内へ移動できます。最新版はダウンロードまたはDriveで確認できます。ここから在庫等のデータは編集しません。</p></section>';
  const inventoryFilters = '<nav class="inventory-filters" aria-label="在庫の種類">' +
    '<button class="inventory-filter selected" type="button" data-inventory-filter="all" aria-pressed="true">すべて</button>' +
    '<button class="inventory-filter" type="button" data-inventory-filter="BOX" aria-pressed="false">BOX</button>' +
    '<button class="inventory-filter" type="button" data-inventory-filter="パック" aria-pressed="false">パック</button>' +
    '<button class="inventory-filter" type="button" data-inventory-filter="カード" aria-pressed="false">シングルカード</button>' +
    '<button class="inventory-filter" type="button" data-inventory-filter="その他" aria-pressed="false">その他</button></nav>';
  const commonHandoffUrl = 'https://drive.google.com/file/d/1j8Mu-oz84zWFE-HPDhcT1_Ah22itSCo7/view';
  const chatHandoffPrefix = [
    'Toreca Vault 通常Chat用引き継ぎ',
    'このChatは購入・受取・開封・売却・抽選など日々の報告窓口です。Workはアプリ開発専用です。',
    '以下は共通引き継ぎ資料の最新内容です。'
  ].join('\n');
  const workHandoffPrefix = [
    'Toreca Vault Work用引き継ぎ',
    '以下の共通引き継ぎ資料を読み、通常Chatの報告が新アプリ正本・画面に届く状態まで開発を続けてください。'
  ].join('\n');
  const handoffDialog = '<dialog class="handoff-dialog" id="handoff-dialog" data-handoff-url="' + commonHandoffUrl + '" aria-labelledby="handoff-title">' +
    '<div class="handoff-dialog-head"><h2 id="handoff-title">Chat / Work 共通引き継ぎ</h2><button class="handoff-close" type="button" data-close-handoff aria-label="閉じる">×</button></div>' +
    '<p class="meta">画面を開く時・アプリに戻った時・更新時・コピー時に最新版を取得します。資料はここからダウンロードできます。</p>' +
    '<a class="handoff-doc-link" href="' + commonHandoffUrl + '" target="_blank" rel="noopener noreferrer">共通引き継ぎ資料を開く ↗</a>' +
    '<a class="handoff-download-link" href="/api/handoff/download" download="Toreca_Vault_Common_Handoff_2026-11-14.md">最新版をダウンロード (.md)</a>' +
    '<button class="handoff-refresh" type="button" data-refresh-handoff>今すぐ更新</button>' +
    '<p class="handoff-live-status" id="handoff-live-status" role="status" aria-live="polite">最新版を読み込むには、この画面を開いてください。</p>' +
    '<pre class="handoff-live-content" id="handoff-live-content">共通引き継ぎ資料は未読込です。</pre>' +
    '<section class="handoff-copy-card"><h3>通常Chat · 日々の報告</h3><p>購入・受取・開封・売却・抽選の報告を続けるための案内。</p><button class="handoff-copy-button" type="button" data-copy-handoff="chat">通常Chat用をコピー</button></section>' +
    '<section class="handoff-copy-card"><h3>Work · アプリ開発</h3><p>障害調査・開発の引き継ぎと、重複防止などの運用ルール。</p><button class="handoff-copy-button" type="button" data-copy-handoff="work">Work用をコピー</button></section>' +
    '<textarea class="handoff-fallback" id="handoff-fallback" readonly hidden aria-label="コピーする引き継ぎ文"></textarea>' +
    '<p class="handoff-copy-status" id="handoff-copy-status" role="status" aria-live="polite"></p>' +
    '<textarea id="chat-handoff-prefix" hidden readonly>' + esc(chatHandoffPrefix) + '</textarea>' +
    '<textarea id="work-handoff-prefix" hidden readonly>' + esc(workHandoffPrefix) + '</textarea>' +
    '</dialog>';
  const pageContent = selectedView === 'assets'
    ? `<div class="metrics">
${metric('参考買取評価額',pricedCount ? money(buybackTotal) : '未算定',pricedCount + '/' + stockQty + '点の有効な買取提示額のみ' + (partiallyPriced ? '・一部未取得' : ''))}
${metric('在庫原価',money(cost),unknownCost ? '原価不明 ' + unknownCost + '点' : '既知の取得原価合計')}
${metric('参考評価差額',comparableQuantity ? money(comparableBuyback - comparableCost) : '未算定','買取提示額の取得分のみ比較（原価不明・未取得分除外）')}
${metric('確定売却益',money(realized),knownSales.length + '/' + sales.length + '件の原価確認済み売却 · 売却履歴を見る','/app?view=history&month=' + month + '&type=sale#history')}
${metric('保有点数',stockQty + '点','BOX ' + categoryTotals.BOX + ' / パック ' + categoryTotals['パック'] + ' / カード ' + categoryTotals['カード'])}
${metric('相場未取得',noPrice + '点','古い買取提示額も未取得に含む')}
</div>
<div class="warning">この画面は新アプリのステージング環境です。本番V2とは独立しており、表示値はステージングの保存データに基づきます。参考買取評価額は、日付・店舗・商品状態・出典を確認できた買取提示額のみの部分合計です。定価・購入原価は買取価格に代用していません。価格のない商品がある場合は総資産額ではありません。</div>`
    : selectedView === 'inventory'
      ? `<section class="panel" id="inventory"><div class="panel-top"><h2>在庫一覧</h2><span class="minor">${lots.length}ロット</span></div>
${inventoryFilters}\n${rows.length ? rows.map(l => inventoryCard(l, pickedByLot.get(l), offersByLot.get(l))).join('') : '<p class="empty">在庫がありません。</p>'}\\n<p class="empty" id="inventory-filter-empty" hidden>この種類の在庫はありません。</p>
</section>`
      : selectedView === 'calendar'
        ? `<section class="panel" id="calendar"><div class="panel-top"><h2>予定カレンダー</h2><span class="minor">抽選・購入期限</span></div>
<details class="winning-shortcut"><summary><span class="winning-shortcut-icon" aria-hidden="true">★</span><span class="winning-shortcut-copy"><b>当選・未受取</b><small>当選した商品の受取状況を確認</small></span><span class="winning-count">${unreceivedWinners.length}件</span></summary><div class="winning-content" id="winning-unreceived">${winningRows}</div></details>
${calendar(month,events,today,selectedDate)}<div id="event-list" class="event-list-head" tabindex="-1"><h2>${esc(selectedDate || month)} の予定</h2>${selectedDate ? '<a href="/app?view=calendar&month=' + month + '#calendar">月全体を見る</a>' : ''}</div>${eventRows}
</section>`
        : selectedView === 'history'
          ? `<section class="panel" id="history"><div class="panel-top"><h2>取引履歴</h2><span class="minor">${historyCountLabel}</span></div>${historyFilters}${transactionRows}</section>`
          : handoverSection;
  const navItems = [
    ['assets', '⌂', '資産', '/app?view=assets'],
    ['inventory', '▤', '在庫', '/app?view=inventory'],
    ['calendar', '▦', '予定', '/app?view=calendar&month=' + month + (selectedDate ? '&date=' + selectedDate + '#event-list' : '#calendar')],
    ['history', '↗', '履歴', '/app?view=history&month=' + month + '&type=' + selectedType + '#history'],
    ['handover', '☷', '引継ぎ', '/app?view=handover']
  ].map(([view, icon, label, href]) => '<a class="bottom-link' + (selectedView === view ? ' active' : '') +
    '" href="' + esc(href) + '" aria-label="' + esc(label) + '"' +
    (selectedView === view ? ' aria-current="page"' : '') + '><span>' + icon + '</span>' + esc(label) + '</a>').join('');
  const css = `
:root{color-scheme:dark;--bg:#0b1220;--card:#151f31;--line:#29394e;--txt:#edf5ff;--muted:#afbed1;--aqua:#70e4d2;--purple:#9888ff}
*{box-sizing:border-box}html{scroll-behavior:auto}body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",system-ui,sans-serif;font-size:15px;line-height:1.6}
a{color:inherit;text-decoration:none}main{max-width:1040px;margin:auto;padding:18px 16px 108px}header{max-width:1040px;margin:auto;padding:24px 16px 8px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:12px;font-weight:750;font-size:20px}.brand-mark{background:linear-gradient(135deg,var(--aqua),#737cff);color:#10182a;padding:10px;border-radius:14px;font-weight:900}.tag{font-size:11px;letter-spacing:.12em;border:1px solid var(--line);border-radius:12px;padding:5px 8px;color:var(--muted)}
.meta{color:var(--muted);font-size:13px}.intro{padding:17px 2px 21px}h1{font-size:26px;letter-spacing:-.04em;margin:4px 0 7px}h2{font-size:19px;margin:0 0 16px}p{margin:0}.kicker{color:var(--aqua);font-size:12px;letter-spacing:.14em;font-weight:700}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.metric,.panel{background:var(--card);border:1px solid var(--line);border-radius:17px}.metric{padding:18px 15px;min-width:0}.metric>div,.metric small{color:var(--muted);font-size:12px}.metric-link{display:block;border-radius:17px}.metric-link:focus-visible{outline:2px solid var(--aqua);outline-offset:3px}.metric-link:hover .metric{border-color:var(--aqua)}.metric strong{display:block;font-size:clamp(17px,5vw,30px);letter-spacing:-.04em;margin:7px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric small{display:block}
.panel{padding:18px;margin-top:18px;scroll-margin-top:16px}.panel-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.panel-top h2{margin:0}.minor{font-size:13px;color:var(--muted)}
.warning{border:1px solid #5c4d39;background:#29261f;color:#f7d79f;border-radius:10px;padding:12px;margin-top:14px;font-size:13px}.stock-row,.event,.history-row{display:flex;justify-content:space-between;gap:10px;padding:13px 0;border-bottom:1px solid var(--line)}.stock-row:last-child,.event:last-child,.history-row:last-child{border:0}
.stock-main{min-width:0;flex:1}.stock-title{display:flex;align-items:center;gap:10px}.stock-icon{width:30px;height:38px;flex:none;color:var(--aqua)}.stock-icon svg{display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.stock-name{font-size:15px;line-height:1.55;font-weight:700;overflow-wrap:anywhere}.stock-meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;color:var(--muted);font-size:12px;margin-top:6px}.pill{background:#25423f;color:var(--aqua);padding:3px 8px;border-radius:50px}.stock-money{display:flex;flex-direction:column;gap:2px;text-align:right;min-width:106px}.stock-money span{color:var(--txt);font-size:13px}.stock-money small{color:var(--muted);font-size:11px}.quote-link{color:var(--aqua);text-decoration:underline}.shop-offers{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.shop-offer{font-size:11px;color:var(--muted);background:#202f40;border:1px solid var(--line);border-radius:7px;padding:4px 6px}.shop-offer a{color:var(--aqua);text-decoration:underline}
.calendar-head{display:flex;justify-content:space-between;align-items:center;margin:18px 0}.calendar-head a{background:#24344b;border-radius:10px;padding:5px 14px;font-size:24px}.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}.weekday{text-align:center;color:var(--muted);font-size:12px;padding:5px}.w0{color:#ff9f9f}.w6{color:#a6afff}.day{width:100%;min-width:0;min-height:50px;border-radius:9px;background:#1e2a3d;padding:7px;display:flex;flex-direction:column;gap:3px;align-items:flex-start;color:var(--txt);border:1px solid transparent;touch-action:manipulation;cursor:pointer}.day:hover,.day:focus-visible{border-color:var(--aqua);outline:none}.day.muted{background:transparent}.day.is-today{outline:2px solid var(--aqua)}.day.is-selected{background:#24504d;border-color:var(--aqua)}.day small{color:var(--aqua);font-size:11px}.event-list-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:23px;scroll-margin-top:16px;scroll-margin-bottom:calc(96px + env(safe-area-inset-bottom))}.event-list-head h2{margin:0}.event-list-head a{color:var(--aqua);font-size:13px;text-decoration:underline}
.history-filters{display:flex;gap:8px;overflow-x:auto;padding:9px 0 13px;scrollbar-width:thin}.history-filter{white-space:nowrap;border:1px solid var(--line);padding:9px 12px;background:#213047;border-radius:12px;color:var(--txt);font-size:13px;min-width:64px;text-align:center}.history-filter.selected{background:#24504d;color:var(--aqua);border-color:var(--aqua);font-weight:700}.history-money{min-width:110px;display:flex;flex-direction:column;gap:4px;align-items:flex-end;text-align:right}.history-money span{font-size:13px;white-space:nowrap}.history-money small{color:var(--muted);font-size:12px}.event{align-items:center;justify-content:flex-start}.event-date{font-weight:750;color:var(--aqua);min-width:45px}.event-kind{font-size:12px;color:var(--muted);min-width:58px}.event-description{overflow-wrap:anywhere}.event-description small{display:block;color:var(--muted)}
.winning-shortcut{margin:10px 0 17px;padding:2px;border-radius:16px;background:linear-gradient(105deg,#ff4f66 0%,#ffb347 17%,#f6eb4c 33%,#53db87 49%,#43d5e6 65%,#4f80ff 82%,#bf62f3 100%);scroll-margin-top:16px}
.winning-shortcut summary{list-style:none;display:flex;align-items:center;gap:12px;min-height:72px;padding:12px 14px;border-radius:14px;background:var(--card);cursor:pointer}
.winning-shortcut summary::-webkit-details-marker{display:none}
.winning-shortcut summary:focus-visible{outline:2px solid var(--txt);outline-offset:3px}
.winning-shortcut summary:after{content:'›';margin-left:2px;color:var(--txt);font-size:25px;line-height:1;transition:transform .15s ease}
.winning-shortcut[open] summary:after{transform:rotate(90deg)}
.winning-shortcut-icon{display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:12px;background:#202f40;color:var(--aqua);font-size:22px}
.winning-shortcut-copy{display:flex;flex:1;min-width:0;flex-direction:column}
.winning-shortcut-copy b{font-size:16px;line-height:1.35}
.winning-shortcut-copy small{color:var(--muted);font-size:12px}
.winning-count{white-space:nowrap;border-radius:99px;background:#24504d;color:var(--aqua);padding:5px 10px;font-size:13px;font-weight:750}
.winning-content{padding:0 13px 12px;background:var(--card);border-radius:0 0 14px 14px}
.winning-item{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:12px 2px;border-top:1px solid var(--line)}
.winning-item b{display:block;font-size:14px;overflow-wrap:anywhere}
.winning-item small,.winning-detail{color:var(--muted);font-size:12px}
.winning-detail{white-space:nowrap}
.winning-empty{padding:12px 2px;color:var(--muted);font-size:13px}
.history-row{align-items:center}.history-row b{display:block;overflow-wrap:anywhere}.history-row small{display:block;color:var(--muted);font-size:12px}.history-row>span{white-space:nowrap;font-size:13px}.positive{color:var(--aqua)}.empty{color:var(--muted);padding:15px 0}
.bottom{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;background:#101b2deb;backdrop-filter:blur(16px);border-top:1px solid var(--line);padding:11px 6px max(17px,env(safe-area-inset-bottom));z-index:3}.bottom a{text-align:center;font-size:13px;min-width:60px;color:#e6effe}.bottom span{display:block;font-size:22px;color:var(--aqua)}
.inventory-filters{display:flex;gap:7px;overflow-x:auto;padding:7px 0 12px;scrollbar-width:thin}.inventory-filter{flex:none;min-height:38px;border:1px solid var(--line);border-radius:20px;background:#202f40;color:var(--muted);padding:7px 11px;font:inherit;font-size:12px;cursor:pointer}.inventory-filter.selected{background:#24504d;color:var(--aqua);border-color:var(--aqua);font-weight:700}.inventory-filter:focus-visible,.handoff-copy-button:focus-visible,.bottom button:focus-visible{outline:2px solid var(--aqua);outline-offset:2px}
.bottom a,.bottom button{text-align:center;font-size:13px;min-width:56px;color:#e6effe}.bottom a.active{color:var(--aqua);font-weight:750}.bottom a.active span{color:var(--aqua)}.bottom button{border:0;background:transparent;font:inherit;cursor:pointer;padding:0 3px}
.handoff-dialog{width:min(520px,calc(100% - 24px));max-height:min(82vh,700px);overflow:auto;margin:auto;padding:20px;background:#172337;color:var(--txt);border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 80px #0009}.handoff-dialog::backdrop{background:#0009;backdrop-filter:blur(3px)}.handoff-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.handoff-dialog-head h2{margin:0}.handoff-close{width:40px;height:40px;border:0;border-radius:10px;background:#202f40;color:var(--txt);font-size:22px;cursor:pointer}.handoff-doc-link,.handoff-download-link{display:inline-flex;margin:14px 10px 2px 0;color:var(--aqua);font-size:12px;text-decoration:underline}.handoff-download-link{border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:#202f40}.handoff-copy-card{margin-top:12px;padding:14px;border:1px solid var(--line);border-radius:14px;background:#111c2e}.handoff-copy-card h3{font-size:14px;margin:0 0 5px}.handoff-copy-card p{color:var(--muted);font-size:12px;margin:0 0 11px}.handoff-copy-button{width:100%;min-height:44px;border:0;border-radius:11px;background:#24504d;color:var(--aqua);font:inherit;font-weight:750;cursor:pointer}.handoff-copy-status{min-height:20px;margin-top:10px;color:var(--aqua);font-size:12px}.handoff-refresh{border:1px solid var(--line);border-radius:9px;background:#202f40;color:var(--txt);padding:8px 12px;margin:6px 0;cursor:pointer}.handoff-refresh:disabled{opacity:.6;cursor:wait}.handoff-live-status{margin:12px 0 5px;color:var(--muted);font-size:11px}.handoff-live-content{max-height:min(32vh,280px);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;border:1px solid var(--line);border-radius:10px;background:#0b1220;color:var(--txt);font:11px/1.55 ui-monospace,monospace}.handoff-fallback{width:100%;min-height:120px;margin-top:8px;padding:10px;border-radius:8px;background:#0b1220;color:var(--txt);border:1px solid var(--line)}[hidden]{display:none!important}
footer{padding:30px 0;color:var(--muted);font-size:12px;text-align:center}.btn{background:#27433f;color:var(--aqua);font-size:12px;padding:10px 12px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}.btn:focus-visible{outline:2px solid var(--aqua);outline-offset:2px}.handover-actions{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0}
@media(min-width:750px){.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}main{padding-bottom:60px}.bottom{position:static;max-width:1040px;margin:auto;border:1px solid var(--line);border-radius:15px 15px 0 0}.day{min-height:80px}}
@media(max-width:520px){.stock-row{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}.stock-main,.stock-title,.stock-name{min-width:0;width:100%}.stock-title{display:grid;grid-template-columns:30px minmax(0,1fr);align-items:start}.stock-name{overflow-wrap:anywhere;word-break:normal}.stock-money{min-width:0;width:100%;text-align:left;align-items:flex-start}.stock-money span,.stock-money small{text-align:left}}
@media(max-width:380px){.stock-money{min-width:88px}.day{padding:4px}.metric{padding:12px}.metric strong{font-size:18px}}
`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220"><title>Toreca Vault · ステージング</title><style>${css}</style></head><body>
<header><div class="brand"><span class="brand-mark">TV</span><span>Toreca Vault</span></div><span class="tag">STAGING · 閲覧専用</span></header>
<main id="top"><section class="intro"><div class="kicker">TORECA VAULT</div><h1>${pageTitles[selectedView]}</h1>
<p class="meta">更新 ${esc(today)} · V2 revision ${esc(revision)}</p></section>
${pageContent}
<footer>読み取り専用 · Toreca Vault staging · データの登録・修正はできません</footer>
</main>
<nav class="bottom" aria-label="カテゴリー">${navItems}</nav>${handoffDialog}<script src="/dashboard.js" defer></script></body></html>`;
}
