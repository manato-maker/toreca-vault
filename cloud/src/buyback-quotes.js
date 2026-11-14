/**
 * Purchase cost and MSRP are never buyback prices. A current buyback quote
 * must be traceable to the selling unit/condition and a dated shop posting.
 * Historical quotes may be shown for context but cannot value current stock.
 */
const SHOPS = [
  { key: 'mimi', test: /買取ミミ|mimi_kaitori/i, account: 'mimi_kaitori' },
  { key: 'allium', test: /カードショップアリウム|アリウム|cardshop_allium/i, account: 'cardshop_allium' },
  { key: 'kuro', test: /トレカショップKURO|カードショップKURO|kuro_tcg/i, account: 'kuro_tcg' },
  { key: 'cardrush', test: /カードラッシュ/i },
  { key: 'toretoku', test: /トレトク/i },
  { key: 'amtaf', test: /AMTAF/i }
];
const NON_BUYBACK = /希望小売価格|メーカー希望|公式定価|定価|参考小売|retail|msrp|販売価格/i;
const TERMINAL = new Set(['review', 'unavailable', 'expired', 'superseded', 'availability_unconfirmed', 'rejected']);
const JST_OFFSET = 9 * 60 * 60 * 1000;
const normalize = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '').trim();

function conditionKey(value) {
  const condition = normalize(value).replace(/[-_・]/g, '');
  if (['あり', '有', '有り', 'シュリンク有', 'シュリンク有り', 'シュリンクあり', 'シュリンク付き', 'シュリンク付'].includes(condition)) return 'shrink';
  if (['なし', '無', '無し', 'シュリンク無', 'シュリンク無し', 'シュリンクなし'].includes(condition)) return 'no-shrink';
  if (['テープあり', 'テープ有り', 'テープ付き', 'テープ付', 'テープ有'].includes(condition)) return 'tape';
  if (['テープなし', 'テープ無し', 'テープ無'].includes(condition)) return 'no-tape';
  return condition;
}

function quotePrice(quote) {
  const value = quote?.buybackYen ?? quote?.price;
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  if (quote?.buybackYen != null && quote?.price != null && quote.buybackYen !== quote.price) return null;
  return value;
}

function shopFor(quote) {
  const label = String(quote.sourceStore || quote.source || '');
  if (NON_BUYBACK.test(label)) return null;
  const shop = SHOPS.find(item => item.test.test(label));
  if (!shop) return null;
  // Only known single-card stores can supply card quotes.
  if (quote.category === 'カード' && !['cardrush', 'toretoku'].includes(shop.key)) return null;
  return shop;
}

function compatible(quote, lot) {
  if (!quote || !lot || !shopFor({ ...quote, category: lot.category })) return false;
  if (String(quote.basis || quote.priceBasis || quote.priceKind || '').match(NON_BUYBACK)) return false;
  // lotId is only a supplementary correlation ID. It must never override
  // a contradictory product, category or selling unit supplied by a shop.
  if (!quote.category || String(quote.category) !== String(lot.category)) return false;
  if (quote.lotId && String(quote.lotId) !== String(lot.id || '')) return false;
  const quoteProduct = normalize(quote.productKey || quote.product);
  const lotProduct = normalize(lot.productKey || lot.product);
  // A bare lotId or guessed unit is not evidence of the product's identity.
  // The actual product and the selling unit must be independently supplied.
  if (!quoteProduct || !lotProduct || quoteProduct !== lotProduct) return false;
  // Do not apply a shrink price to a no-shrink item, and do not reuse
  // carton/case or pack prices for individual BOX units.
  const unit = normalize(quote.unit || quote.salesUnit);
  const allowedUnit = {
    BOX: ['box', 'box単品'],
    'パック': ['pack', 'パック'],
    'カード': ['card', 'カード'],
    'カートン': ['case', 'carton', 'カートン']
  }[lot.category];
  if (!allowedUnit || !allowedUnit.includes(unit)) return false;
  if (quote.condition === undefined || quote.condition === null || String(quote.condition).trim() === '') {
    if (lot.condition) return false;
  } else if (conditionKey(quote.condition) !== conditionKey(lot.condition)) return false;
  return quotePrice(quote) !== null;
}

function stamp(value) {
  if (!value) return null;
  const raw = String(value);
  const epoch = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? Date.parse(raw + 'T00:00:00+09:00') : Date.parse(raw);
  return Number.isFinite(epoch) ? epoch : null;
}

function validSourceUrl(quote, shop) {
  const url = String(quote.postUrl || quote.sourceUrl || '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return '';
    if (shop.account) {
      if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) return '';
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length !== 3 || parts[0].toLowerCase() !== shop.account
        || parts[1] !== 'status' || !/^\d+$/.test(parts[2])) return '';
    }
    return parsed.href;
  } catch { return ''; }
}

function confirmed(quote, shop, nowMs) {
  if (quote.fresh === false || TERMINAL.has(String(quote.status || '').toLowerCase())) return false;
  if (String(quote.status || '').toLowerCase() !== 'verified') return false;
  if (quote.quoteType === 'pickup_limited' && quote.availabilityConfirmed !== true) return false;
  const url = validSourceUrl(quote, shop);
  if (!url) return false;
  // Current X quotes require the actual post time with an explicit zone.
  // A photo's "11/14 update" caption by itself cannot prove post recency.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(quote.postedAt || ''))) return false;
  const posted = stamp(quote.postedAt);
  if (posted === null || posted > nowMs + 10 * 60 * 1000) return false;
  const validUntil = stamp(quote.validUntil);
  if (quote.validUntil) {
    if (validUntil === null) return false;
    // A YYYY-MM-DD validUntil includes the shop's calendar date in JST.
    const until = /^\d{4}-\d{2}-\d{2}$/.test(String(quote.validUntil))
      ? validUntil + 24 * 60 * 60 * 1000 - 1 : validUntil;
    if (nowMs > until) return false;
  } else {
    // Default X buyback images are time-sensitive. Treat undated expiry
    // as a one-day price, not as indefinitely guaranteed.
    if (nowMs - posted > 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

/** The latest CURRENT verified offer per shop, sorted by price.
 * A price reduction supersedes the earlier quote for the same shop even if
 * both posts remain within their original displayed date window.
 * Conflicting prices from the same shop at exactly the same posted timestamp
 * are excluded pending review, rather than choosing the higher one.
 */
export function buybackOffersForLot(quotes, lot, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return [];
  const groups = new Map();
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (!compatible(quote, lot)) continue;
    const shop = shopFor({ ...quote, category: lot.category });
    if (!shop || !confirmed(quote, shop, nowMs)) continue;
    if (!groups.has(shop.key)) groups.set(shop.key, []);
    groups.get(shop.key).push(quote);
  }
  const live = [];
  for (const offers of groups.values()) {
    offers.sort((a,b) => String(b.postedAt).localeCompare(String(a.postedAt)));
    const latestTime = String(offers[0]?.postedAt || '');
    const latest = offers.filter(x => String(x.postedAt) === latestTime);
    if (latest.some(x => quotePrice(x) !== quotePrice(latest[0]))) continue;
    live.push(latest[0]);
  }
  return live.sort((a,b) => quotePrice(b) - quotePrice(a)
    || String(b.postedAt).localeCompare(String(a.postedAt)));
}

/** Pick the highest currently verified SHOP BUYBACK (not historical MSRP).
 * Return the last dated older buyback as history only if there is no live quote.
 */
export function buybackForLot(quotes, lot, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const matches = (Array.isArray(quotes) ? quotes : []).filter(q => compatible(q, lot));
  if (!matches.length || !Number.isFinite(nowMs)) return { status: 'missing', quote: null, price: null };
  const live = buybackOffersForLot(matches, lot, now);
  if (live.length) {
    return { status: 'current', quote: live[0], price: quotePrice(live[0]) };
  }
  const historical = matches.filter(q => ['verified', 'superseded', 'expired'].includes(String(q.status || '').toLowerCase())
    && !!buybackSourceUrl(q) && stamp(q.postedAt || q.quotedAt || q.checkedAt) !== null);
  historical.sort((a, b) => (stamp(b.postedAt || b.quotedAt || b.checkedAt) || 0)
    - (stamp(a.postedAt || a.quotedAt || a.checkedAt) || 0));
  const old = historical[0] || null;
  return { status: old ? 'stale' : 'missing', quote: old, price: old ? quotePrice(old) : null };
}
export function buybackSourceUrl(quote) {
  const shop = shopFor(quote || {});
  return shop ? validSourceUrl(quote, shop) : '';
}
export function buybackTimestamp(quote) {
  return String(quote?.postedAt || quote?.quotedAt || quote?.checkedAt || '').slice(0, 10);
}
