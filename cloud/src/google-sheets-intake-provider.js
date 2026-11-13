const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const INTAKE_TITLE = 'Toreca Vault New App Intake';
const SHEET_NAME = 'Intake';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ROWS = 50;

function validateSpreadsheetId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(id)) {
    throw new TypeError('spreadsheetId is invalid');
  }
  return id;
}

async function responseJson(response, label) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new RangeError(`${label} response is too large`);
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

/**
 * Least-scope Sheets API adapter for a dedicated new-app intake spreadsheet.
 * It refuses any title/tab other than the exact isolated intake target.
 */
export function createGoogleSheetsIntakeProvider({
  spreadsheetId,
  getAccessToken,
  fetchImpl = globalThis.fetch
} = {}) {
  const id = validateSpreadsheetId(spreadsheetId);
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  let targetVerified = false;

  async function request(url, init, label) {
    const token = await getAccessToken();
    if (typeof token !== 'string' || token.length < 16 || /\s/.test(token)) throw new Error('Google Sheets access token is unavailable');
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers || {})
      },
      signal: AbortSignal.timeout(10_000)
    });
    return responseJson(response, label);
  }

  async function verifyTarget() {
    if (targetVerified) return;
    const url = `${API_ROOT}/${encodeURIComponent(id)}?fields=${encodeURIComponent('properties.title,sheets.properties.title')}`;
    const metadata = await request(url, { method: 'GET' }, 'Google Sheets metadata lookup');
    const tabNames = Array.isArray(metadata.sheets)
      ? metadata.sheets.map((sheet) => String(sheet?.properties?.title || '')) : [];
    if (metadata.properties?.title !== INTAKE_TITLE || !tabNames.includes(SHEET_NAME)) {
      throw new Error('configured spreadsheet is not the dedicated new-app intake sheet');
    }
    targetVerified = true;
  }

  return {
    async readRows({ startRow = 2, limit = 20 } = {}) {
      if (!Number.isSafeInteger(startRow) || startRow < 2 || startRow > 100_001) {
        throw new RangeError('startRow is outside the allowed intake range');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new RangeError('row limit must be from 1 to 50');
      await verifyTarget();
      const range = encodeURIComponent(`${SHEET_NAME}!A${startRow}:D${startRow + limit - 1}`);
      const url = `${API_ROOT}/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
      const body = await request(url, { method: 'GET' }, 'Google Sheets intake read');
      if (!Array.isArray(body.values)) return [];
      if (body.values.length > limit) throw new Error('Google Sheets returned more rows than requested');
      return body.values.map((values, index) => {
        if (!Array.isArray(values)) throw new Error('Google Sheets returned a malformed row');
        return { rowNumber: index + startRow, values: values.slice(0, 4) };
      });
    },

    async writeReceipt(rowNumber, receipt, sourceRequestId = receipt?.acceptedRequestId) {
      if (!Number.isSafeInteger(rowNumber) || rowNumber < 2 || rowNumber > 100_001) {
        throw new RangeError('rowNumber is outside the allowed intake range');
      }
      if (!receipt || !['queued', 'processing', 'v2-applied', 'duplicate', 'review'].includes(receipt.status)
        || !/^[a-z0-9-]{1,48}$/.test(String(receipt.resultCode || ''))
        || typeof receipt.acceptedRequestId !== 'string'
        || !Number.isSafeInteger(receipt.processedAtMs) || receipt.processedAtMs < 0) {
        throw new TypeError('intake receipt is invalid');
      }
      await verifyTarget();
      const sourceRows = await this.readRows({ startRow: rowNumber, limit: 1 });
      // For review rows, acceptedRequestId is blank; for cross-source business
      // duplicates it belongs to another request. Neither identifies source A.
      // The source ID is only used as a compare-before-write guard, never written.
      if (typeof sourceRequestId !== 'string' || sourceRequestId.length > 200
        || sourceRows.length !== 1 || sourceRows[0].rowNumber !== rowNumber
        || String(sourceRows[0].values[0] ?? '') !== sourceRequestId) {
        throw new Error('intake row request ID changed before receipt write');
      }
      const range = encodeURIComponent(`${SHEET_NAME}!D${rowNumber}:G${rowNumber}`);
      const url = `${API_ROOT}/${encodeURIComponent(id)}/values/${range}?valueInputOption=RAW`;
      const body = {
        majorDimension: 'ROWS',
        values: [[receipt.status, receipt.resultCode, receipt.acceptedRequestId, receipt.processedAtMs]]
      };
      const result = await request(url, { method: 'PUT', body: JSON.stringify(body) }, 'Google Sheets intake receipt write');
      if (!Number.isSafeInteger(result.updatedCells) || result.updatedCells !== 4) {
        throw new Error('Google Sheets did not confirm all receipt cells');
      }
      const readbackUrl = `${API_ROOT}/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
      const readback = await request(readbackUrl, { method: 'GET' }, 'Google Sheets intake receipt readback');
      const actual = Array.isArray(readback.values) && readback.values.length === 1 && Array.isArray(readback.values[0])
        ? readback.values[0].slice(0, 4) : [];
      const expected = [receipt.status, receipt.resultCode, receipt.acceptedRequestId, receipt.processedAtMs];
      if (actual.length !== 4 || actual.some((value, index) => value !== expected[index])) {
        throw new Error('Google Sheets intake receipt readback did not match');
      }
      return { updated: true };
    }
  };
}

export const googleSheetsIntakeSchema = Object.freeze({
  title: INTAKE_TITLE,
  sheetName: SHEET_NAME,
  headers: Object.freeze(['requestId', 'commandJson', 'businessEventIdentityJson', 'status', 'resultCode', 'acceptedRequestId', 'processedAtMs'])
});

