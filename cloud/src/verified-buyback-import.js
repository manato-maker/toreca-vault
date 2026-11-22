import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';
import { buybackForLot, buybackSourceUrl } from './buyback-quotes.js';

const MAX_QUOTES = 60;
const asText = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '').trim();
const canonCondition = value => {
  const v = asText(value);
  if (['あり','有り','有','シュリンク有','シュリンクあり','シュリンク付き'].includes(v)) return 'shrink';
  if (['なし','無し','無','シュリンク無','シュリンクなし'].includes(v)) return 'no-shrink';
  return v;
};
const sourceIdentity = q => JSON.stringify([
  asText(q.sourceStore), asText(q.productKey), q.category, canonCondition(q.condition)
]);
const postIdentity = q => JSON.stringify([
  sourceIdentity(q), String(q.postUrl || ''), String(q.unit || '')
]);
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = data => structuredClone(data);

function enforceEvidence(q, lots, now) {
  if (!q || typeof q !== 'object' || Array.isArray(q)
    || !q.sourceStore || !q.productKey || !q.category
    || !Object.hasOwn(q,'condition') || typeof q.condition !== 'string'
    || !['box','pack','card','case','BOX','パック','カード','カートン'].includes(String(q.unit || ''))
    || !q.postedAt || !q.postUrl || q.status !== 'verified'
    || !Number.isSafeInteger(q.price) || q.price <= 0
    || (q.buybackYen !== undefined && q.buybackYen !== q.price)) {
    throw new Error('evidence missing required store, product, unit, condition, original post, price, or verification status');
  }
  if (q.quoteType === 'pickup_limited' && q.availabilityConfirmed !== true) {
    throw new Error('limited pickup requires independently confirmed eligibility');
  }
  const matches = lots.filter(lot => buybackForLot([q], lot, now).status === 'current');
  if (!matches.length) throw new Error('evidence not verified, expired, or does not match an inventory lot');
  const url = buybackSourceUrl(q);
  if (!url || url !== q.postUrl) throw new Error('original shop post URL is not permitted or not canonical');
  if (Date.parse(q.postedAt) > now.getTime()) throw new Error('future posting is not valid');
  return matches;
}

export function previewVerifiedBuybackImport(snapshot, records, {
  expectedRevision, mutationId, now = new Date()
} = {}) {
  const state = clone(snapshot);
  validateState(state);
  if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) {
    throw new Error('snapshot revision differs from approved expected revision');
  }
  if (!/^[a-zA-Z0-9:._-]{12,120}$/.test(String(mutationId || ''))) {
    throw new Error('stable unique mutationId is required');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('invalid clock');
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_QUOTES) {
    throw new Error('verified quote batch must contain 1-60 records');
  }
  const fingerprint = hash(JSON.stringify(records));
  const oldMutation = state.auditLog.find(x => x.mutationId === mutationId);
  if (oldMutation) {
    if (oldMutation.buybackBatchSha256 !== fingerprint) throw new Error('mutationId collision: different quote batch');
    return { state, idempotent: true, added: 0, replaced: 0, skipped: records.length,
      matchingLots: 0, mutationId, fingerprint };
  }
  const lots = state.inventoryLots.filter(lot => Number(lot.quantity) > 0);
  const inputIDs = new Set();
  const seenLots = new Set();
  let added = 0, replaced = 0, skipped = 0;
  for (const record of records) {
    const q = clone(record);
    const matchingLots = enforceEvidence(q, lots, now);
    for (const lot of matchingLots) seenLots.add(lot.id);
    const id = postIdentity(q);
    if (inputIDs.has(id)) throw new Error('same source post/product/condition repeated in this batch');
    inputIDs.add(id);
    const family = sourceIdentity(q);
    const comparable = state.marketQuotes.filter(prev => sourceIdentity(prev) === family);
    const duplicate = comparable.find(prev => postIdentity(prev) === id);
    if (duplicate) {
      if (duplicate.price !== q.price || duplicate.status === 'rejected') {
        throw new Error('post URL already exists with a different amount or rejected status');
      }
      skipped++;
      continue;
    }
    const newPosted = Date.parse(q.postedAt);
    if (!Number.isFinite(newPosted)) throw new Error('posting timestamp invalid');
    for (const old of comparable) {
      const oldPosted = Date.parse(old.postedAt || old.quotedAt || '');
      if (Number.isFinite(oldPosted) && oldPosted >= newPosted) {
        throw new Error('new offer is not later than the previous verified shop posting');
      }
    }
    for (const old of comparable) {
      if (old.status === 'verified') {
        old.status = 'superseded';
        old.fresh = false;
        replaced++;
      }
    }
    state.marketQuotes.push({
      productKey: q.productKey, category: q.category, condition: q.condition,
      unit: q.unit, price: q.price, buybackYen: q.price, priceBasis: 'buyback',
      source: q.sourceStore, sourceStore: q.sourceStore,
      postUrl: q.postUrl, postedAt: q.postedAt, quotedAt: q.postedAt,
      lastCheckedAt: now.toISOString(), validUntil: String(q.validUntil || ''),
      fresh: true, status: 'verified', quoteType: q.quoteType || 'regular',
      availabilityConfirmed: q.availabilityConfirmed === true,
      quoteId: hash(id), checkedAt: now.toISOString()
    });
    added++;
  }
  if (!added && !replaced) {
    return { state: snapshot, idempotent: false, added, replaced, skipped,
      matchingLots: seenLots.size, mutationId, fingerprint };
  }
  state.revision = expectedRevision + 1;
  state.lastMutationId = mutationId;
  state.auditLog.push({
    mutationId, kind: 'verified-buyback-import', revision: state.revision,
    buybackBatchSha256: fingerprint, quoteAdded: added, quoteSuperseded: replaced
  });
  validateState(state);
  // Only marketQuotes/revision/auditLog/lastMutationId may change.
  for (const field of ['inventoryLots','transactions','lotteries']) {
    if (JSON.stringify(state[field]) !== JSON.stringify(snapshot[field])) {
      throw new Error('buyback import attempted to modify ' + field);
    }
  }
  return { state, idempotent: false, added, replaced, skipped,
    matchingLots: seenLots.size, mutationId, fingerprint };
}

export async function commitVerifiedBuybackImport({
  store, records, expectedRevision, mutationId, now = new Date(), apply = false
} = {}) {
  if (!store || typeof store.read !== 'function') throw new Error('canonical store required');
  const current = await store.read();
  if (!current?.payload || current.revision !== current.payload.revision) {
    throw new Error('canonical state unavailable or revision mismatch');
  }
  const preview = previewVerifiedBuybackImport(current.payload, records,
    { expectedRevision, mutationId, now });
  const summary = {
    revisionBefore: current.revision, revisionAfter: preview.state.revision,
    added: preview.added, superseded: preview.replaced,
    skipped: preview.skipped, matchingLots: preview.matchingLots,
    idempotent: preview.idempotent
  };
  if (!apply || preview.idempotent || preview.added === 0) return { ...summary, applied: false };
  if (typeof store.save !== 'function') throw new Error('canonical write permission not enabled');
  await store.save({ expectedRevision, mutationId, payload: preview.state });
  const readback = await store.read();
  if (!readback?.payload || readback.revision !== expectedRevision + 1
    || readback.payload.lastMutationId !== mutationId
    || JSON.stringify(readback.payload.marketQuotes) !== JSON.stringify(preview.state.marketQuotes)) {
    throw new Error('verified buyback import readback failed');
  }
  for (const field of ['inventoryLots','transactions','lotteries']) {
    if (JSON.stringify(readback.payload[field]) !== JSON.stringify(current.payload[field])) {
      throw new Error('canonical non-price fields changed during buyback import');
    }
  }
  return { ...summary, applied: true, readbackVerified: true };
}
