import { positiveMarketTargets, validateState } from '../../v2/core.js';

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

function validQuote(value) {
  return value && Number.isSafeInteger(value.price) && value.price >= 0
    && typeof value.source === 'string' && value.source.trim().length > 0
    && value.source.trim().length <= 120;
}

function findQuoteIndex(quotes, target, key) {
  return quotes.findIndex((quote) => quote.targetKey === key
    || (quote.category === target.category
      && valueKey(quote.productKey) === valueKey(target.productKey)
      && String(quote.condition || '') === String(target.condition || target.shrinkStatus || '')));
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
  const ambiguousResponseKeys = new Set();
  try {
    const response = await provider.lookupMany(targets.map((target) => ({ ...target, targetKey: marketTargetKey(target) })));
    if (Array.isArray(response)) {
      for (const item of response) {
        if (!item || typeof item.targetKey !== 'string') continue;
        if (responseByKey.has(item.targetKey)) {
          responseByKey.delete(item.targetKey);
          ambiguousResponseKeys.add(item.targetKey);
          continue;
        }
        if (ambiguousResponseKeys.has(item.targetKey)) continue;
        responseByKey.set(item.targetKey, item);
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
    const result = ambiguousResponseKeys.has(targetKey) ? null : responseByKey.get(targetKey);
    const index = findQuoteIndex(next.marketQuotes, target, targetKey);
    const previous = index >= 0 ? next.marketQuotes[index] : null;
    if (validQuote(result)) {
      const quote = {
        ...(previous || {}),
        targetKey,
        productKey: target.productKey || target.product,
        category: target.category,
        condition: target.condition || target.shrinkStatus || '',
        price: result.price,
        source: result.source.trim(),
        quotedAt: refreshedAt,
        lastCheckedAt: refreshedAt,
        fresh: true,
        trend: 'current'
      };
      if (index >= 0) next.marketQuotes[index] = quote;
      else next.marketQuotes.push(quote);
      refreshedCount += 1;
    } else {
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
