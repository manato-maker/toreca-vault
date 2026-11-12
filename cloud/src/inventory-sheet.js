const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const SPREADSHEET_TITLE = 'Toreca Vault New App Intake';
const INVENTORY_TAB = '在庫一覧';
const MAX_RESPONSE_BYTES = 1_000_000;

async function responseJson(response, label) {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new RangeError(label + ' response is too large');
  }
  if (!response.ok) throw new Error(label + ' failed with HTTP ' + response.status);
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error(label + ' returned invalid JSON');
  }
}

function stockRows(payload, updatedAt) {
  const grouped = new Map();
  for (const lot of payload.inventoryLots) {
    const quantity = Number(lot?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    const product = String(lot.product || lot.productKey || '').trim();
    const productKey = String(lot.productKey || product).normalize('NFKC').toLocaleLowerCase('ja').replace(/[\\s\\u3000]/g, '');
    const category = String(lot.category || '');
    const condition = String(lot.condition || '');
    const cardSet = String(lot.set || '');
    if (!product || !productKey) continue;
    const key = JSON.stringify([productKey, category, condition, cardSet]);
    let item = grouped.get(key);
    if (!item) {
      item = { product, category, condition, cardSet, quantity: 0, costTotal: 0, unknownCost: false };
      grouped.set(key, item);
    }
    item.quantity += quantity;
    const unitCost = lot.unitCost;
    if (unitCost === null || unitCost === undefined || unitCost === '' || !Number.isFinite(Number(unitCost))) {
      item.unknownCost = true;
    } else {
      item.costTotal += quantity * Number(unitCost);
    }
  }
  const rows = [...grouped.values()]
    .sort((a, b) => a.category.localeCompare(b.category, 'ja') || a.product.localeCompare(b.product, 'ja')
      || a.condition.localeCompare(b.condition, 'ja') || a.cardSet.localeCompare(b.cardSet, 'ja'))
    .map((item) => [
      item.product,
      item.category,
      item.condition,
      item.cardSet,
      item.quantity,
      item.unknownCost ? '' : item.costTotal,
      item.unknownCost ? '要確認' : '確認済み'
    ]);
  const jst = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short'
  }).format(updatedAt);
  return [
    ['在庫一覧', '最終同期: ' + jst, 'Firestore revision: ' + Number(payload.revision)],
    ['商品名', 'カテゴリ', '状態', 'カード/セット', '数量', '在庫原価合計（円）', '原価状況'],
    ...rows
  ];
}

function normalized(values, rowCount, columnCount) {
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => values?.[rowIndex]?.[columnIndex] ?? '')
  );
}

export function createInventorySheetSync({
  store,
  spreadsheetId,
  getAccessToken,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!store || typeof store.read !== 'function') throw new TypeError('store.read is required');
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
    throw new TypeError('spreadsheetId is invalid');
  }
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function request(url, init, label) {
    const token = await getAccessToken();
    if (typeof token !== 'string' || token.length < 16 || /\\s/.test(token)) {
      throw new Error('Google Sheets access token is unavailable');
    }
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: 'Bearer ' + token,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers || {})
      },
      signal: AbortSignal.timeout(10_000)
    });
    return responseJson(response, label);
  }

  async function getMetadata() {
    const fields = encodeURIComponent('properties.title,sheets.properties(sheetId,title)');
    return request(API_ROOT + '/' + encodeURIComponent(spreadsheetId) + '?fields=' + fields,
      { method: 'GET' }, 'Google Sheets metadata lookup');
  }

  async function ensureTab() {
    let metadata = await getMetadata();
    const names = Array.isArray(metadata.sheets)
      ? metadata.sheets.map((sheet) => String(sheet?.properties?.title || '')) : [];
    if (metadata.properties?.title !== SPREADSHEET_TITLE || !names.includes('Intake')) {
      throw new Error('configured spreadsheet is not the dedicated new-app intake sheet');
    }
    if (!names.includes(INVENTORY_TAB)) {
      await request(API_ROOT + '/' + encodeURIComponent(spreadsheetId) + ':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: {
          title: INVENTORY_TAB,
          gridProperties: { frozenRowCount: 2 }
        } } }] })
      }, 'Google Sheets inventory tab creation');
      metadata = await getMetadata();
    }
    const sheet = metadata.sheets?.find((item) => item?.properties?.title === INVENTORY_TAB);
    const sheetId = sheet?.properties?.sheetId;
    if (!Number.isSafeInteger(sheetId)) throw new Error('inventory sheet tab is unavailable');
    return sheetId;
  }

  return {
    async sync() {
      const current = await store.read();
      if (!current || !current.payload || !Number.isSafeInteger(Number(current.revision))) {
        throw new Error('canonical inventory is not initialized');
      }
      const rows = stockRows(current.payload, new Date());
      const sheetId = await ensureTab();
      const existingRange = encodeURIComponent(INVENTORY_TAB + '!A1:G5000');
      const existing = await request(API_ROOT + '/' + encodeURIComponent(spreadsheetId)
        + '/values/' + existingRange + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE',
      { method: 'GET' }, 'Google Sheets inventory prior-state read');
      if (Array.isArray(existing.values) && existing.values.length >= 5000) {
        throw new Error('inventory sheet exceeds the safe row limit');
      }
      const rowCount = Math.max(rows.length, Array.isArray(existing.values) ? existing.values.length : 0);
      const values = Array.from({ length: rowCount }, (_, rowIndex) => ({
        values: Array.from({ length: 7 }, (_, columnIndex) => {
          const value = rows[rowIndex]?.[columnIndex] ?? '';
          if (typeof value === 'number' && Number.isFinite(value)) {
            return { userEnteredValue: { numberValue: value } };
          }
          return value === '' ? {} : { userEnteredValue: { stringValue: String(value) } };
        })
      }));
      await request(API_ROOT + '/' + encodeURIComponent(spreadsheetId) + ':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            updateCells: {
              start: { sheetId, rowIndex: 0, columnIndex: 0 },
              rows: values,
              fields: 'userEnteredValue'
            }
          }]
        })
      }, 'Google Sheets inventory update');

      const endRow = Math.max(rows.length, 2);
      const range = encodeURIComponent(INVENTORY_TAB + '!A1:G' + endRow);
      const result = await request(API_ROOT + '/' + encodeURIComponent(spreadsheetId)
        + '/values/' + range + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE',
      { method: 'GET' }, 'Google Sheets inventory readback');
      const actual = normalized(result.values, rows.length, 7);
      if (actual.some((row, rowIndex) => row.some((value, columnIndex) => value !== rows[rowIndex][columnIndex]))) {
        throw new Error('Google Sheets inventory readback did not match');
      }
      return { rowCount: rows.length - 2, revision: Number(current.revision) };
    }
  };
}
