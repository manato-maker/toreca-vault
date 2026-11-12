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
const state = { credential: '', data: null, filter: 'all', view: 'assets' };
const $ = (id) => document.getElementById(id);

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
  const market = row.marketPrice == null
    ? '価格未取得'
    : money.format(row.marketPrice) + ' / 個';
  const cost = row.unitCost == null
    ? '原価要確認'
    : money.format(row.unitCost) + ' / 個';
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

  const empty = '<div class="empty-state">この種別の在庫はありません</div>';
  $('inventory-list').innerHTML = filtered.length
    ? filtered.map(inventoryCard).join('')
    : empty;

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

function renderView() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.hidden = panel.id !== state.view + '-view';
  });
  if (state.view === 'activity') renderActivity();
  if (state.view === 'inventory') renderInventory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigate(view, filter = 'all') {
  state.view = view;
  state.filter = filter;
  document.querySelectorAll('.filter').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });
  renderView();
}

async function loadData(credential = state.credential) {
  if (!credential) return;
  setStatus('在庫を読み込み中…');
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
