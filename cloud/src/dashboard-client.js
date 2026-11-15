export const dashboardClientScript = `
(() => {
  const dialog = document.getElementById('handoff-dialog');
  const openButton = document.querySelector('[data-open-handoff]');
  const closeButton = document.querySelector('[data-close-handoff]');
  const copyStatus = document.getElementById('handoff-copy-status');
  const fallback = document.getElementById('handoff-fallback');

  if (dialog && openButton) {
    openButton.addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      openButton.setAttribute('aria-expanded', 'true');
    });
    dialog.addEventListener('close', () => openButton.setAttribute('aria-expanded', 'false'));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  if (dialog && closeButton) closeButton.addEventListener('click', () => dialog.close());

  document.querySelectorAll('[data-copy-handoff]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-copy-handoff');
      const source = document.getElementById(target + '-handoff-text');
      const value = source ? source.value : '';
      if (!value) return;
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(value);
        if (fallback) fallback.hidden = true;
        if (copyStatus) copyStatus.textContent = 'コピーしました。Chat / Workに貼り付けてください。';
      } catch {
        if (fallback) {
          fallback.hidden = false;
          fallback.value = value;
          fallback.focus();
          fallback.select();
        }
        if (copyStatus) copyStatus.textContent = '自動コピーできません。選択した文を長押ししてコピーしてください。';
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
