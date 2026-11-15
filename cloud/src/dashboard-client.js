export const dashboardClientScript = `
(() => {
  const dialog = document.getElementById('handoff-dialog');
  const openButton = document.querySelector('[data-open-handoff]');
  const closeButton = document.querySelector('[data-close-handoff]');
  const refreshButton = document.querySelector('[data-refresh-handoff]');
  const copyStatus = document.getElementById('handoff-copy-status');
  const fallback = document.getElementById('handoff-fallback');
  const liveStatus = document.getElementById('handoff-live-status');
  const liveContent = document.getElementById('handoff-live-content');
  let latestHandoff = '';
  let latestModifiedTime = '';
  let refreshTimer = null;

  async function loadHandoff({ silent = false, force = false } = {}) {
    if (!silent) {
      if (liveStatus) liveStatus.textContent = '共通引き継ぎ資料の最新版を確認中…';
      if (liveContent && !latestHandoff) liveContent.textContent = '読み込み中…';
    }
    try {
      const query = latestModifiedTime && !force ? '?modifiedTime=' + encodeURIComponent(latestModifiedTime) : '';
      const response = await fetch('/api/handoff' + query, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      });
      if (response.status === 304 && latestHandoff) {
        if (liveStatus) {
          const modified = latestModifiedTime ? new Date(latestModifiedTime).toLocaleString('ja-JP') : '';
          liveStatus.textContent = modified ? 'Drive最終更新: ' + modified + '（最新）' : '共通引き継ぎ資料は最新です。';
        }
        return latestHandoff;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || typeof data.content !== 'string') throw new Error('handoff unavailable');
      latestHandoff = data.content;
      latestModifiedTime = typeof data.modifiedTime === 'string' ? data.modifiedTime : '';
      if (liveContent) liveContent.textContent = latestHandoff;
      if (liveStatus) {
        const modified = data.modifiedTime ? new Date(data.modifiedTime).toLocaleString('ja-JP') : '';
        liveStatus.textContent = modified ? 'Drive最終更新: ' + modified : '最新の共通引き継ぎ資料を読み込みました。';
      }
      return latestHandoff;
    } catch {
      if (!silent) {
        if (liveContent) liveContent.textContent = '最新の共通引き継ぎ資料を取得できませんでした。';
        if (liveStatus) liveStatus.textContent = '更新確認に失敗しました。コピーは行いません。時間をおいて再試行してください。';
        latestHandoff = '';
        latestModifiedTime = '';
      } else if (liveStatus) {
        liveStatus.textContent = '更新確認に失敗しました。次回も自動確認します。';
      }
      throw new Error('handoff unavailable');
    }
  }

  if (dialog && openButton) {
    openButton.addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      openButton.setAttribute('aria-expanded', 'true');
      void loadHandoff({ force: true }).catch(() => {});
      if (refreshTimer) window.clearInterval(refreshTimer);
      refreshTimer = window.setInterval(() => {
        if (!document.hidden && dialog.open && latestModifiedTime) void loadHandoff({ silent: true }).catch(() => {});
      }, 60000);
    });
    dialog.addEventListener('close', () => {
      openButton.setAttribute('aria-expanded', 'false');
      if (refreshTimer) window.clearInterval(refreshTimer);
      refreshTimer = null;
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  if (dialog && closeButton) closeButton.addEventListener('click', () => dialog.close());
  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      try { await loadHandoff({ force: true }); }
      catch {}
      finally { refreshButton.disabled = false; }
    });
  }

  document.querySelectorAll('[data-copy-handoff]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-copy-handoff');
      const prefixElement = document.getElementById(target + '-handoff-prefix');
      const prefix = prefixElement ? prefixElement.value.trim() : '';
      button.disabled = true;
      try {
        const current = await loadHandoff({ force: true });
        const sourceUrl = dialog ? dialog.getAttribute('data-handoff-url') || '' : '';
        const value = prefix + '\n\n' + current.trim() + (sourceUrl ? '\n\n共通資料: ' + sourceUrl : '');
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(value);
          if (fallback) fallback.hidden = true;
          if (copyStatus) copyStatus.textContent = '最新版をコピーしました。Chat / Workに貼り付けてください。';
        } catch {
          if (fallback) {
            fallback.hidden = false;
            fallback.value = value;
            fallback.focus();
            fallback.select();
          }
          if (copyStatus) copyStatus.textContent = '最新版は取得済みです。表示された文面を長押ししてコピーしてください。';
        }
      } catch {
        if (copyStatus) copyStatus.textContent = '最新資料を取得できないため、コピーを中止しました。';
      } finally {
        button.disabled = false;
      }
    });
  });

  const filters = [...document.querySelectorAll('[data-inventory-filter]')];
  const stockRows = [...document.querySelectorAll('[data-inventory-category]')];
  const empty = document.getElementById('inventory-filter-empty');
  filters.forEach((button) => {
    button.addEventListener('click', () => {
      const selected = button.getAttribute('data-inventory-filter') || 'all';
      let visible = 0;
      filters.forEach((item) => {
        const active = item === button;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-pressed', String(active));
      });
      stockRows.forEach((row) => {
        const show = selected === 'all' || row.getAttribute('data-inventory-category') === selected;
        row.hidden = !show;
        if (show) visible += 1;
      });
      if (empty) empty.hidden = visible > 0;
    });
  });
})();
`;
