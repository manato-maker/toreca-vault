const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESULT_TERMS = '{当選 落選 抽選結果}';
const LOTTERY_TERMS = '{from:info@pokemoncenter-online.com from:noreply@ml.yamada-denki.jp from:noreply@livepocket.jp 抽選 当選 落選 応募 申込}';

function timestamp(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative integer timestamp`);
  return number;
}

function checkedCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') throw new TypeError('cursor must be an object');
  const sinceMs = timestamp(cursor.sinceMs, 'cursor.sinceMs');
  const untilMs = timestamp(cursor.untilMs, 'cursor.untilMs');
  if (untilMs <= sinceMs || !['hourly', 'results'].includes(cursor.scanType)) throw new TypeError('cursor bounds or scanType are invalid');
  const pageToken = cursor.pageToken == null ? null : String(cursor.pageToken);
  if (pageToken && pageToken.length > 2048) throw new TypeError('pageToken is too long');
  return { sinceMs, untilMs, scanType: cursor.scanType, pageToken };
}

/** Plan one fixed-bound Gmail query page. Persist the cursor only after message jobs settle. */
export function planGmailScanPage({ nowMs, lastSuccessfulAtMs = null, cursor = null, scanType = 'hourly', maxResults = 100, overlapMs = null, initialLookbackMs = 7 * DAY_MS } = {}) {
  const now = timestamp(nowMs, 'nowMs');
  if (!['hourly', 'results'].includes(scanType)) throw new TypeError('scanType must be hourly or results');
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new TypeError('maxResults must be from 1 to 100');
  const overlap = overlapMs == null ? (scanType === 'results' ? 6 * HOUR_MS : 15 * 60 * 1000) : timestamp(overlapMs, 'overlapMs');
  const lookback = timestamp(initialLookbackMs, 'initialLookbackMs');
  let bounds;
  if (cursor != null) {
    bounds = checkedCursor(cursor);
    if (bounds.scanType !== scanType || bounds.untilMs > now) throw new TypeError('cursor does not belong to this scan window');
  } else {
    let sinceMs = now - lookback;
    if (lastSuccessfulAtMs != null) sinceMs = Math.max(0, timestamp(lastSuccessfulAtMs, 'lastSuccessfulAtMs') - overlap);
    if (sinceMs >= now) throw new TypeError('Gmail scan window is empty');
    bounds = { sinceMs, untilMs: now, scanType, pageToken: null };
  }
  const afterSeconds = Math.max(0, Math.floor(bounds.sinceMs / 1000) - 1);
  const beforeSeconds = Math.floor(bounds.untilMs / 1000) + 1;
  const terms = scanType === 'results' ? RESULT_TERMS : LOTTERY_TERMS;
  return {
    query: `after:${afterSeconds} before:${beforeSeconds} ${terms}`,
    maxResults,
    pageToken: bounds.pageToken,
    cursor: bounds
  };
}

/** Advance only after the page's returned messages have been durably processed. */
export function advanceGmailScanPage(cursor, { nextPageToken = null } = {}) {
  const current = checkedCursor(cursor);
  if (nextPageToken != null && String(nextPageToken)) {
    const token = String(nextPageToken);
    if (token.length > 2048) throw new TypeError('nextPageToken is too long');
    return { complete: false, cursor: { ...current, pageToken: token }, lastSuccessfulAtMs: null };
  }
  return { complete: true, cursor: null, lastSuccessfulAtMs: current.untilMs };
}
