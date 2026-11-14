import { positiveMarketTargets, validateState } from '../../v2/core.js';
import { buybackForLot } from './buyback-quotes.js';

const MAX_TARGETS_PER_REFRESH = 500;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function valueKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase('ja');
}

export function marketTargetKey(target) {
  return JSON.stringify([
    String(target.category || ''),
    valueKey(target.productKey || target.product),
    String(target.condition || target.shrinkStatus || '')
  ]);
}

function validQuote(value, target, checkedAt) {
  if (!value || !Number.isSafeInteger(value.price) || value.price <= 0
    || typeof value.source !== 'string' || !value.source.trim() || value.source.trim().length > 120
    || value.category !== target.category
    || !String(value.productKey || '').trim()
    || valueKey(value.productKey) !== valueKey(target.productKey || target.product)
    || typeof value.condition !== 'string'
    || !['box', 'pack', 'card', 'case', 'BOX', 'パック', 'カード', 'カートン'].includes(String(value.unit || ''))) {
    return false;
  }
  // A price without a dated verified shop posting may be MSRP, a selling
  // price or a stale image. It must not enter the current buyback ledger.
  const checked = value; // Do not fill missing provider identity/condition from the target.
  const lot = { category: target.category, productKey: target.productKey || target.product,
    condition: target.condition || target.shrinkStatus || '' };
  const matched = buybackForLot([checked], lot, checkedAt);
  return matched.status === 'current' && matched.price === value.price;
}

function findQuoteIndex(quotes, target, key, sourceStore = '') {
  const matchingTarget = (quote) => quote.targetKey === key
    || (quote.category === target.category
      && valueKey(quote.productKey) === valueKey(target.productKey)
      && String(quote.condition || '') === String(target.condition || target.shrinkStatus || ''));
  if (sourceStore) {
    // Prefer the latest matching shop offer, not an older superseded record.
    // This works for both legacy single-price rows and dated offer history.
    const candidates = quotes.map((quote, index) => ({ quote, index }))
      .filter(({ quote }) => matchingTarget(quote)
        && valueKey(quote.sourceStore || quote.source) === valueKey(sourceStore));
    candidates.sort((a, b) => (Date.parse(b.quote.postedAt || b.quote.quotedAt || '') || 0)
      - (Date.parse(a.quote.postedAt || a.quote.quotedAt || '') || 0));
    return candidates[0]?.index ?? -1;
  }
  return quotes.findIndex(matchingTarget);
}

/** Refresh quotes with one injected batch lookup; failed/untrusted results keep the previous price stale. */
export async function refreshMarketQuotes({
  store,
  provider,
  mutationId,
  runAt = new Date(),
  maxTargets = MAX_TARGETS_PER_REFRESH
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('a revisioned V2 store is required');
  }
  if (!provider || typeof provider.lookupMany !== 'function') {
    throw new TypeError('a batched market quote provider is required');
  }
  if (typeof mutationId !== 'string' || !mutationId.trim()) throw new TypeError('a stable mutationId is required');
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > MAX_TARGETS_PER_REFRESH) {
    throw new RangeError('maxTargets is outside the safe limit');
  }
  const checkedAt = runAt instanceof Date ? new Date(runAt.getTime()) : new Date(runAt);
  if (Number.isNaN(checkedAt.getTime())) throw new TypeError('runAt must be a valid time');
  const checkedAtIso = checkedAt.toISOString();

  const current = await store.read();
  if (!current?.payload) throw new Error('Canonical V2 snapshot is not initialized');
  if (!Number.isSafeInteger(current.revision) || current.revision < 0
    || current.revision !== current.payload.revision) throw new Error('Canonical revision does not match payload');
  const original = clone(current.payload);
  validateState(original);
  if (original.lastMutationId === mutationId || original.auditLog.some((entry) => entry.mutationId === mutationId)) {
    return { skipped: false, idempotent: true, revision: current.revision, refreshedCount: 0, staleCount: 0 };
  }
  const targets = positiveMarketTargets(original);
  if (targets.length === 0) return { skipped: true, reason: 'no-inventory-targets', refreshedCount: 0, staleCount: 0 };
  if (targets.length > maxTargets) throw new RangeError('Market target count exceeds the configured limit');

  let responseByKey = new Map();
  const ambiguousShopKeys = new Set();
  try {
    const response = await provider.lookupMany(targets.map((target) => ({
      ...target, targetKey: marketTargetKey(target)
    })));
    if (Array.isArray(response)) {
      for (const item of response) {
        if (!item || typeof item.targetKey !== 'string') continue;
        const shopKey = valueKey(item.sourceStore || item.source);
        const pairKey = JSON.stringify([item.targetKey, shopKey]);
        if (!responseByKey.has(item.targetKey)) responseByKey.set(item.targetKey, new Map());
        const byShop = responseByKey.get(item.targetKey);
        if (ambiguousShopKeys.has(pairKey)) continue;
        if (byShop.has(shopKey)) {
          // Conflicting or repeated provider records from the same shop are
          // ambiguous; reject that shop only, not competitors' verified quotes.
          byShop.delete(shopKey);
          ambiguousShopKeys.add(pairKey);
          continue;
        }
        byShop.set(shopKey, item);
      }
    }
  } catch {
    responseByKey = new Map();
  }

  const next = clone(original);
  const refreshedAt = checkedAtIso;
  let refreshedCount = 0;
  let staleCount = 0;
  for (const target of targets) {
    const targetKey = marketTargetKey(target);
    const candidates = [...(responseByKey.get(targetKey)?.values() || [])];
    const accepted = candidates.filter(result => validQuote(result, target, checkedAt));
    let acceptedForTarget = 0;
    let rejectedOlderReplay = false;

    for (const result of accepted) {
      const shop = String(result.sourceStore || result.source).trim();
      const index = findQuoteIndex(next.marketQuotes, target, targetKey, shop);
      const previous = index >= 0 ? next.marketQuotes[index] : null;
      const currentPosted = Date.parse(result.postedAt);
      const oldPosted = Date.parse(previous?.postedAt || previous?.quotedAt || '');
      // A provider cache can return yesterday's high price after a shop
      // lowered its offer. Reject backwards timestamps and conflicting reuse
      // of the same timestamp or individual posting URL.
      if (Number.isFinite(oldPosted)
        && (currentPosted < oldPosted
          || (currentPosted === oldPosted
            && (previous.price !== result.price
              || (previous.postUrl && previous.postUrl !== (result.postUrl || result.sourceUrl)))))) {
        rejectedOlderReplay = true;
        continue;
      }
      if (previous && previous.postUrl && previous.postUrl === (result.postUrl || result.sourceUrl)
        && previous.price !== result.price) {
        rejectedOlderReplay = true;
        continue;
      }
      const quote = {
        targetKey,
        productKey: target.productKey || target.product,
        category: target.category,
        condition: target.condition || target.shrinkStatus || '',
        price: result.price,
        buybackYen: result.price,
        source: result.source.trim(),
        sourceStore: shop,
        priceBasis: 'buyback',
        status: 'verified',
        postedAt: String(result.postedAt),
        postUrl: String(result.postUrl || result.sourceUrl),
        quotedAt: String(result.postedAt),
        validUntil: String(result.validUntil || ''),
        unit: String(result.unit || ''),
        quoteType: String(result.quoteType || 'regular'),
        availabilityConfirmed: result.availabilityConfirmed === true,
        lastCheckedAt: refreshedAt,
        fresh: true,
        trend: 'current'
      };
      if (index >= 0 && previous?.postUrl === quote.postUrl) {
        next.marketQuotes[index] = { ...previous, ...quote };
      } else {
        // Retain the prior posting as history, rather than replacing it with
        // a different URL or collapsing two shop offers into a single price.
        if (previous && index >= 0 && previous.status === 'verified') {
          next.marketQuotes[index] = { ...previous, status: 'superseded', fresh: false, trend: 'stale' };
        }
        next.marketQuotes.push(quote);
      }
      acceptedForTarget += 1;
      refreshedCount += 1;
    }

    if (acceptedForTarget === 0) {
      if (rejectedOlderReplay) {
        // An outdated provider cache is not evidence that a more recent
        // already-verified shop posting has become invalid. Leave the saved
        // quote untouched; the renderer still enforces its expiration.
        staleCount += 1;
        continue;
      }
      const index = findQuoteIndex(next.marketQuotes, target, targetKey);
      const previous = index >= 0 ? next.marketQuotes[index] : null;
      const quote = {
        ...(previous || {}),
        targetKey,
        productKey: target.productKey || target.product,
        category: target.category,
        condition: target.condition || target.shrinkStatus || '',
        price: previous?.price ?? null,
        source: previous?.source ?? null,
        quotedAt: previous?.quotedAt ?? null,
        lastCheckedAt: refreshedAt,
        fresh: false,
        trend: 'stale'
      };
      if (index >= 0) next.marketQuotes[index] = quote;
      else next.marketQuotes.push(quote);
      staleCount += 1;
    }
  }

  const nextRevision = current.revision + 1;
  next.revision = nextRevision;
  next.lastMutationId = mutationId;
  next.auditLog.push({ mutationId, revision: nextRevision, kind: 'market-refresh' });
  next.automation = next.automation && typeof next.automation === 'object' ? next.automation : {};
  next.automation.health = next.automation.health && typeof next.automation.health === 'object'
    ? next.automation.health : {};
  const previousHealth = next.automation.health.marketRefresh || {};
  next.automation.health.marketRefresh = {
    lastAttemptAt: checkedAtIso,
    lastSuccessfulAt: refreshedCount > 0 ? checkedAtIso : previousHealth.lastSuccessfulAt || null,
    refreshedCount,
    staleCount,
    status: staleCount > 0 ? 'degraded' : 'healthy'
  };
  validateState(next);
  await store.save({ expectedRevision: current.revision, mutationId, payload: next });
  const readback = await store.read();
  if (!readback?.payload || readback.revision !== nextRevision
    || readback.payload.lastMutationId !== mutationId
    || JSON.stringify(readback.payload.marketQuotes) !== JSON.stringify(next.marketQuotes)) {
    throw new Error('Market quote readback verification failed');
  }
  return { skipped: false, revision: nextRevision, refreshedCount, staleCount, checkedAt: checkedAtIso };
}

export function createMarketRefreshHandler(options = {}) {
  return async function handleMarketRefresh(job) {
    if (job?.kind !== 'market-refresh' || typeof job.jobKey !== 'string'
      || !/^market-refresh:\d{4}-\d{2}-\d{2}$/.test(job.jobKey)) {
      throw new TypeError('a scheduled daily market-refresh job is required');
    }
    return refreshMarketQuotes({
      ...options,
      mutationId: job.jobKey,
      runAt: job.scheduledAt
    });
  };
}
