const FEED_URL = 'https://torekakaku-navi.com/';
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_CURRENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FEED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const X_EPOCH_MS = 1_288_834_974_657n;

const STORES = {
  cardshop_allium: 'カードショップアリウム',
  mimi_kaitori: '買取ミミ',
  AMTAF_SHOP: 'AMTAF',
  kuro_tcg: 'トレカショップKURO'
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function normalized(value) {
  return decodeHtml(value).normalize('NFKC').toLocaleLowerCase('ja')
    .replace(/^ポケモンカードゲーム/, '')
    .replace(/^mega/, '')
    .replace(/^(?:強化拡張|拡張|ハイクラス)パック/, '')
    .replace(/\d+\s*(?:box|ボックス|パック)$/i, '')
    .replace(/(?:未開封)?(?:box|ボックス|パック)$/i, '')
    .replace(/[\s\u3000\-＿_・:：()（）【】\[\]「」『』"']/g, '');
}

function snapshotFromHtml(html, now) {
  const plain = decodeHtml(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
  const match = plain.match(/掲載日\s*(\d{4}-\d{2}-\d{2})\s*\/\s*スナップショット\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match || match[1] !== match[2]) throw new Error('public buyback feed snapshot timestamp is missing or inconsistent');
  const snapshotAt = new Date(`${match[2]}T${match[3]}:${match[4]}:${match[5]}+09:00`);
  if (Number.isNaN(snapshotAt.getTime()) || snapshotAt.getTime() > now.getTime() + 5 * 60_000
    || now.getTime() - snapshotAt.getTime() > MAX_FEED_AGE_MS) {
    throw new Error('public buyback feed snapshot is outside the current 24-hour window');
  }
  return snapshotAt;
}

function postTimeFromUrl(value, expectedHandle) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname.toLowerCase())
      || parts.length !== 3 || parts[0].toLowerCase() !== expectedHandle
      || parts[1] !== 'status' || !/^\d{15,20}$/.test(parts[2])) return null;
    const id = BigInt(parts[2]);
    const postedAtMs = Number((id >> 22n) + X_EPOCH_MS);
    if (!Number.isSafeInteger(postedAtMs) || postedAtMs < Date.UTC(2010, 0, 1)) return null;
    return { url: url.href, postedAt: new Date(postedAtMs) };
  } catch { return null; }
}

function conditionForTarget(target) {
  const condition = normalized(target.condition);
  if (target.category === 'パック') {
    return /未開封|バラ|パック/.test(condition) && !/開封済/.test(condition) ? 'loose_pack' : null;
  }
  if (target.category !== 'BOX') return null;
  if (['なし', '無', '無し', 'シュリンクなし', 'シュリンク無', 'シュリンク無し', '未シュリンク'].includes(condition)) return 'no_shrink';
  if (['あり', '有', '有り', 'シュリンクあり', 'シュリンク有', 'シュリンク有り', 'シュリンク付き', 'シュリンク付'].includes(condition)) return 'shrink';
  const name = normalized(`${target.product || ''} ${target.productKey || ''}`);
  const sealedOther = (name.includes('30thcelebration') && /(?:プレミアム|スペシャル)デッキ/.test(name))
    || name.includes('スタートデッキ100');
  if (sealedOther && /未開封|未使用/.test(condition) && !/開封済/.test(condition)) return 'shrink';
  return null;
}

function parseProducts(html) {
  const starts = [...html.matchAll(/<div\s+class="card(?:\s[^"]*)?"[^>]*>/gi)];
  const products = [];
  for (let index = 0; index < starts.length; index += 1) {
    const head = starts[index][0];
    const category = (head.match(/\bdata-cat="([^"]+)"/i) || [])[1] || '';
    if (!['box', 'sealed_other'].includes(category)) continue;
    const name = decodeHtml((head.match(/\bdata-name="([^"]+)"/i) || [])[1] || '');
    if (!name) continue;
    const block = html.slice(starts[index].index, starts[index + 1]?.index || html.length);
    const official = decodeHtml((block.match(/<span\s+class="official">([^<]+)<\/span>/i) || [])[1] || '');
    const rowStarts = [...block.matchAll(/<div\s+class="crow\b[^>]*\bdata-cond="(shrink|no_shrink|loose_pack)"[^>]*>/gi)];
    const offers = {};
    for (let rowIndex = 0; rowIndex < rowStarts.length; rowIndex += 1) {
      const condition = rowStarts[rowIndex][1];
      const section = block.slice(rowStarts[rowIndex].index, rowStarts[rowIndex + 1]?.index || block.length);
      offers[condition] = [];
      for (const cellMatch of section.matchAll(/<div\s+class="cell\b[^>]*>[\s\S]*?<\/div>/gi)) {
        const cell = cellMatch[0];
        const source = cell.match(/class="src"\s+href="(https:\/\/x\.com\/([^"/]+)\/status\/(\d+))"/i);
        const shopLink = cell.match(/class="shop-link"\s+href="https:\/\/x\.com\/([^"/]+)"/i);
        const handle = (source?.[2] || shopLink?.[1] || '').toLowerCase();
        const priceText = (cell.match(/class="price yen">¥([\d,]+)</i) || [])[1] || '';
        const price = Number(priceText.replace(/,/g, ''));
        if (!Object.hasOwn(STORES, handle) || !source || source[2].toLowerCase() !== handle
          || !Number.isSafeInteger(price) || price <= 0) continue;
        const sourcePost = postTimeFromUrl(source[1], handle);
        if (sourcePost) offers[condition].push({ sourceStore: STORES[handle], postUrl: sourcePost.url,
          postedAt: sourcePost.postedAt, price });
      }
    }
    const identity = starterDeckProductIdentity(name, official || name);
    products.push({ name, official: official || name, category, offers, identity });
  }
  return products;
}

function starterDeckProductIdentity(name, official = '') {
  const value = normalized(`${name || ''} ${official || ''}`);
  if (!value.includes('スタートデッキ100')) return '';
  if (/白箱|詰め合わせ|カートン|assortment|whitebox/.test(value)) return 'starter-deck-100-white-box';
  if (/バトルコレクション|battlecollection/.test(value)) return 'starter-deck-100-retail-single';
  if (/単品|単体|1個(?:入り)?|single(?:deck)?|retailpackage/.test(value)) return 'starter-deck-100-retail-single';
  return 'starter-deck-100-ambiguous';
}

function productMatches(target, product) {
  const rawTargetNames = [target.product, target.productKey].filter(Boolean);
  const targetNames = rawTargetNames.map(normalized).filter(value => value.length >= 4);
  const productNames = [product.name, product.official].map(normalized).filter(Boolean);
  if (!targetNames.length || !productNames.length) return false;
  const targetIsStarterDeck = targetNames.some(name => name.includes('スタートデッキ100'));
  if (targetIsStarterDeck && product.identity !== 'starter-deck-100-retail-single') return false;
  const comparisonKey = value => value.replace(/(?:単品|単体|1個入り|1個|single(?:deck)?|retailpackage)/g, '');
  return targetNames.some(name => productNames.some(productName =>
    comparisonKey(name) === comparisonKey(productName)));
}

export function parsePublicBuybackFeed(html, { now = new Date() } = {}) {
  const checkedAt = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(checkedAt.getTime())) throw new TypeError('a valid current time is required');
  const body = String(html || '');
  if (!body || Buffer.byteLength(body, 'utf8') > MAX_HTML_BYTES) throw new Error('public buyback feed is empty or exceeds the size limit');
  const snapshotAt = snapshotFromHtml(body, checkedAt);
  return { snapshotAt, products: parseProducts(body) };
}

export function createPublicBuybackFeedProvider({
  fetchImpl = globalThis.fetch,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required');
  return {
    async lookupMany(targets) {
      const checkedAt = now();
      const unsupported = targets.filter(target => !conditionForTarget(target))
        .map(target => ({ targetKey: target.targetKey, skip: true, sourceStore: 'public-feed' }));
      let response;
      try {
        response = await fetchImpl(FEED_URL, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12_000),
          headers: { accept: 'text/html', 'user-agent': 'TorecaVault-staging/1.0 (daily public buyback snapshot)' } });
      } catch {
        return unsupported;
      }
      if (!response?.ok || response.url && new URL(response.url).hostname !== 'torekakaku-navi.com') return unsupported;
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > MAX_HTML_BYTES) return unsupported;
      let html;
      try { html = await response.text(); } catch { return unsupported; }
      let feed;
      try { feed = parsePublicBuybackFeed(html, { now: checkedAt }); } catch { return unsupported; }

      const validUntil = new Date(feed.snapshotAt.getTime() + MAX_CURRENT_AGE_MS).toISOString();
      const found = [];
      for (const target of targets) {
        const condition = conditionForTarget(target);
        if (!condition) continue;
        const candidates = feed.products.filter(product => productMatches(target, product));
        if (candidates.length !== 1) continue;
        const offers = candidates[0].offers[condition] || [];
        const byStore = new Map();
        for (const offer of offers) {
          if (offer.postedAt.getTime() > feed.snapshotAt.getTime() + 5 * 60_000) continue;
          const prior = byStore.get(offer.sourceStore);
          if (prior && prior.price !== offer.price) { byStore.delete(offer.sourceStore); continue; }
          if (!byStore.has(offer.sourceStore)) byStore.set(offer.sourceStore, offer);
        }
        for (const offer of byStore.values()) {
          found.push({ targetKey: target.targetKey,
            product: target.product || target.productKey, productKey: target.productKey || target.product,
            category: target.category, condition: target.condition,
            unit: target.category === 'BOX' ? 'box' : 'pack', price: offer.price, buybackYen: offer.price,
            source: offer.sourceStore, sourceStore: offer.sourceStore, priceBasis: 'buyback',
            postUrl: offer.postUrl, postedAt: offer.postedAt.toISOString(), quotedAt: offer.postedAt.toISOString(),
            validUntil, lastCheckedAt: checkedAt.toISOString(), feedSnapshotAt: feed.snapshotAt.toISOString(),
            sourcePlatform: 'public-feed', status: 'verified',
            ...(candidates[0].identity ? { productIdentity: candidates[0].identity } : {}),
            fresh: checkedAt.getTime() <= feed.snapshotAt.getTime() + MAX_CURRENT_AGE_MS });
        }
      }
      return [...found, ...unsupported];
    }
  };
}
