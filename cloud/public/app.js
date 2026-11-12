const config = window.TV2_APP_CONFIG || {};
const money = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0
});
const dayFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'long',
  day: 'numeric',
  weekday: 'short'
});
const timeFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit'
});
const monthFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'long'
});
const state = {
  credential: '',
  data: null,
  filter: 'all',
  view: 'assets',
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: dateKey(new Date())
};
const $ = (id) => document.getElementById(id);

function dateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

function showDashboard() {
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('bottom-nav').hidden = false;
}

function showLogin(message = '') {
  $('login').hidden = false;
  $('dashboard').hidden = true;
  $('bottom-nav').hidden = true;
  if (message) $('login-message').textContent = message;
}

function renderSummary(data) {
  const assets = data.assets;
  $('total-assets').textContent = money.format(assets.total);
  $('asset-difference').textContent =
    '現在庫取得原価との差額 ' + (assets.difference >= 0 ? '+' : '') + money.format(assets.difference);
  $('asset-difference').classList.toggle('negative', assets.difference < 0);
  $('realized-profit').textContent =
    (data.realizedProfit >= 0 ? '+' : '') + money.format(data.realizedProfit);
  $('income-realized-profit').textContent =
    (data.realizedProfit >= 0 ? '+' : '') + money.format(data.realizedProfit);
  $('inventory-cost').textContent = money.format(assets.inventoryCost);
  $('cards-value').textContent = money.format(assets.cards);
  $('boxes-value').textContent = money.format(assets.boxes);
  $('packs-value').textContent = money.format(assets.packs);
  $('purchases-total').textContent = money.format(assets.purchases);
  $('sales-total').textContent = money.format(assets.sales);
  $('income-purchases-total').textContent = money.format(assets.purchases);
  $('income-sales-total').textContent = money.format(assets.sales);
  $('revision').textContent = String(data.revision);
}

function inventoryCard(row) {
  const product = row.product + (row.set ? ' · ' + row.set : '');
  const market = row.marketPrice == null ? '価格未取得' : money.format(row.marketPrice) + ' / 個';
  const cost = row.unitCost == null ? '原価要確認' : money.format(row.unitCost) + ' / 個';
  const category = row.category || '種別未設定';
  const condition = row.condition || '状態未設定';
  const review = row.identityNeedsReview ? '<span class="pill review-pill">内容確認</span>' : '';
  return '<article class="stock-card">' +
    '<div class="stock-top"><div class="stock-name">' + escapeHtml(product) + '</div>' +
    '<div class="stock-qty">× ' + escapeHtml(row.quantity) + '</div></div>' +
    '<div class="stock-meta"><span class="pill">' + escapeHtml(category) + '</span>' +
    '<span class="pill">' + escapeHtml(condition) + '</span>' + review + '</div>' +
    '<div class="stock-bottom"><span>取得原価 ' + escapeHtml(cost) + '</span>' +
    '<span>推定価格 ' + escapeHtml(market) + '</span></div></article>';
}

function renderInventory() {
  const all = state.data?.inventory || [];
  const filtered = state.filter === 'all'
    ? all
    : all.filter((row) => row.category === state.filter);
  const quantity = filtered.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  $('stock-count').textContent = filtered.length + '種類 · 計' + quantity + '点';
  $('inventory-list').innerHTML = filtered.length
    ? filtered.map(inventoryCard).join('')
    : '<div class="empty-state">この種別の在庫はありません</div>';
  const preview = all.slice(0, 3);
  $('inventory-preview').innerHTML = preview.length
    ? preview.map(inventoryCard).join('')
    : '<div class="empty-state">在庫データがまだありません</div>';
}

function renderActivity() {
  const rows = state.data?.transactions || [];
  if (!rows.length) {
    $('activity-list').innerHTML = '<div class="empty-state">取引履歴はありません</div>';
    return;
  }
  $('activity-list').innerHTML = rows.map((row) => {
    const prefix = row.type === '売却' ? '+' : row.type === '購入' ? '−' : '';
    const amount = row.amount ? prefix + money.format(row.amount) : '—';
    return '<article class="stock-card activity-card" data-type="' + escapeHtml(row.type) + '">' +
      '<div class="stock-top"><div class="stock-name">' +
      escapeHtml(row.product || '商品未設定') + '</div><div class="activity-amount">' +
      escapeHtml(amount) + '</div></div><div class="stock-meta">' +
      '<span class="pill">' + escapeHtml(row.type) + '</span>' +
      '<span class="pill">' + escapeHtml(row.date || '日付未設定') + '</span>' +
      '<span class="pill">× ' + escapeHtml(row.quantity) + '</span></div></article>';
  }).join('');
}

const calendarTypeClass = (event) => {
  if (event.status === '当選') return 'won';
  if (event.status === '落選') return 'lost';
  return ({
    '応募': 'application',
    '応募締切': 'deadline',
    '当選発表': 'result',
    '受取': 'receipt',
    '受取期限': 'receipt',
    '購入': 'transaction',
    '売却': 'transaction',
    '開封': 'transaction'
  }[event.type] || 'transaction');
};

function renderCalendar() {
  const events = state.data?.calendarEvents || [];
  const eventMap = new Map();
  for (const event of events) {
    if (!eventMap.has(event.date)) eventMap.set(event.date, []);
    eventMap.get(event.date).push(event);
  }

  const year = state.calendarMonth.getFullYear();
  const month = state.calendarMonth.getMonth();
  $('calendar-month').textContent = monthFormat.format(state.calendarMonth);
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const key = dateKey(date);
    const dayEvents = eventMap.get(key) || [];
    const classes = ['calendar-day'];
    if (date.getMonth() !== month) classes.push('muted');
    if (key === state.selectedDate) classes.push('selected');
    if (key === dateKey(new Date())) classes.push('today');
    if (dayEvents.length) classes.push('has-events');
    const dots = dayEvents.slice(0, 4).map((event) =>
      '<i class="calendar-dot ' + calendarTypeClass(event) + '"></i>'
    ).join('');
    const more = dayEvents.length > 4 ? '<span class="calendar-more">+' + (dayEvents.length - 4) + '</span>' : '';
    cells.push(
      '<button class="' + classes.join(' ') + '" data-date="' + key + '" role="gridcell" aria-label="' +
      escapeHtml(key + '、予定 ' + dayEvents.length + '件') + '">' +
      '<span class="day-number">' + date.getDate() + '</span><span class="day-dots">' + dots + more + '</span></button>'
    );
  }
  $('calendar-grid').innerHTML = cells.join('');
  $('calendar-grid').querySelectorAll('.calendar-day').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedDate = button.dataset.date;
      renderCalendar();
    });
  });

  const selectedEvents = eventMap.get(state.selectedDate) || [];
  const selected = new Date(state.selectedDate + 'T00:00:00');
  $('selected-date').textContent = dayFormat.format(selected);
  $('selected-count').textContent = selectedEvents.length ? selectedEvents.length + '件' : '';
  $('calendar-events').innerHTML = selectedEvents.length
    ? selectedEvents.map(calendarEventCard).join('')
    : '<div class="empty-state">この日の予定・取引はありません</div>';
}

function calendarEventCard(event) {
  const details = [];
  if (event.store) details.push(escapeHtml(event.store));
  if (event.status) details.push(escapeHtml(event.status));
  if (event.receiptStatus) details.push('受取: ' + escapeHtml(event.receiptStatus));
  if (event.quantity != null) details.push('数量 ' + escapeHtml(event.quantity));
  if (event.amount != null) details.push(money.format(event.amount));
  if (event.memo) details.push(escapeHtml(event.memo));
  const source = event.sourceUrl
    ? '<a href="' + escapeHtml(event.sourceUrl) + '" target="_blank" rel="noopener noreferrer">参考リンクを開く ↗</a>'
    : '';
  return '<article class="stock-card calendar-event" data-kind="' + escapeHtml(event.type) + '" data-status="' + escapeHtml(event.status) + '" data-receipt="' + escapeHtml(event.receiptStatus) + '">' +
    '<div class="calendar-event-title">' + escapeHtml(event.type) + ' · ' + escapeHtml(event.title) + '</div>' +
    (details.length ? '<div class="calendar-event-meta">' + details.join(' · ') + '</div>' : '') +
    source + '</article>';
}

function moveCalendar(monthDelta) {
  state.calendarMonth = new Date(
    state.calendarMonth.getFullYear(),
    state.calendarMonth.getMonth() + monthDelta,
    1
  );
  state.selectedDate = dateKey(state.calendarMonth);
  renderCalendar();
}

function navigate(view, filter = 'all') {
  state.view = view;
  state.filter = filter;
  document.querySelectorAll('.filter').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });
  renderView();
}

function renderView() {
  const activeNav = state.view === 'inventory' ? 'assets' : state.view;
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === activeNav);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.hidden = panel.id !== state.view + '-view';
  });
  if (state.view === 'inventory') renderInventory();
  if (state.view === 'activity') renderActivity();
  if (state.view === 'calendar') renderCalendar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadData(credential = state.credential) {
  if (!credential) return;
  setStatus('在庫・予定を読み込み中…');
  try {
    const response = await fetch('/api/v2/dashboard', {
      headers: { authorization: 'Bearer ' + credential },
      cache: 'no-store'
    });
    const result = await response.json();
    if (response.status === 401 || response.status === 403) {
      state.credential = '';
      showLogin('ログインを確認できません。Googleアカウントで再度ログインしてください。');
      return;
    }
    if (!response.ok || !result.ok) throw new Error(result.error || '読み込みに失敗しました');

    state.data = result;
    state.credential = credential;
    renderSummary(result);
    renderInventory();
    renderActivity();
    renderCalendar();
    renderView();
    showDashboard();
    setStatus('最終取得 ' + timeFormat.format(new Date(result.updatedAt)));
  } catch (error) {
    setStatus(error.message || '読み込みに失敗しました', true);
  }
}

function initializeGoogle() {
  if (!config.googleClientId) {
    showLogin('Googleログイン設定がまだ完了していません。');
    return;
  }
  if (!window.google?.accounts?.id) {
    window.setTimeout(initializeGoogle, 250);
    return;
  }
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: async (response) => {
      if (response?.credential) await loadData(response.credential);
    }
  });
  window.google.accounts.id.renderButton($('google-signin'), {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    width: 260
  });
}

$('today').textContent = dayFormat.format(new Date());
$('refresh').addEventListener('click', () => loadData());
$('calendar-prev').addEventListener('click', () => moveCalendar(-1));
$('calendar-next').addEventListener('click', () => moveCalendar(1));
$('calendar-today').addEventListener('click', () => {
  const today = new Date();
  state.calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  state.selectedDate = dateKey(today);
  renderCalendar();
});
document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => navigate('inventory', button.dataset.filter));
});
document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.view));
});
document.querySelectorAll('[data-nav]').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.nav));
});
document.querySelectorAll('[data-open-inventory]').forEach((button) => {
  button.addEventListener('click', () => navigate('inventory', button.dataset.openInventory));
});
initializeGoogle();
