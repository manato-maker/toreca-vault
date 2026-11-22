import { createLotteryBusinessEventKey } from './business-event-identity.js';

const RETAILER_ALIASES = new Map([
  ['pokemoncenteronline', 'pokemoncenter-online'],
  ['ポケモンセンターオンライン', 'pokemoncenter-online'],
  ['ポケセンオンライン', 'pokemoncenter-online'],
  ['cardboxosaka', 'cardbox-osaka'],
  ['カードボックスオーサカ店', 'cardbox-osaka'],
  ['カードボックスオーサカ', 'cardbox-osaka'],
  ['cardboxnihonbashi', 'cardbox-nihonbashi'],
  ['カードボックス日本橋店', 'cardbox-nihonbashi'],
  ['カードボックス日本橋', 'cardbox-nihonbashi'],
  ['yamada', 'yamada-denki'],
  ['ヤマダデンキ', 'yamada-denki'],
  ['ヤマダ電機', 'yamada-denki']
]);

const ID_LABEL = /(?:抽選\s*)?(?:お申込み|お申し込み|申込み|申し込み|申込|応募|エントリー)(?:番号|no\.?|id)|受付番号/giu;
const ID_VALUE = /^[\s:：#№-]*([A-Z0-9][A-Z0-9._/-]{0,79})/iu;

function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function retailerLookupKey(value) {
  return normalizeText(value).toLocaleLowerCase('ja').replace(/[\s\u3000・._-]/g, '');
}

export function canonicalizeLotteryRetailer(value) {
  const key = retailerLookupKey(value);
  const retailerKey = key ? RETAILER_ALIASES.get(key) : undefined;
  return retailerKey
    ? { status: 'ready', retailerKey }
    : { status: 'review', reasonCode: key ? 'lottery-retailer-unknown' : 'lottery-retailer-missing' };
}

/** Return an ID only when it follows an explicit application/entry label. */
export function extractExplicitLotteryApplicationId(evidence) {
  const text = normalizeText(evidence);
  if (!text) return { status: 'review', reasonCode: 'lottery-application-id-missing' };

  const ids = new Set();
  ID_LABEL.lastIndex = 0;
  for (const match of text.matchAll(ID_LABEL)) {
    const tail = text.slice(match.index + match[0].length);
    const value = ID_VALUE.exec(tail)?.[1];
    if (value) ids.add(normalizeText(value));
  }
  if (ids.size !== 1) {
    return { status: 'review', reasonCode: ids.size ? 'lottery-application-id-ambiguous' : 'lottery-application-id-missing' };
  }
  return { status: 'ready', applicationId: [...ids][0] };
}

function resolveIdentity({ kind, retailer, evidence, explicitApplicationId } = {}) {
  const canonicalRetailer = canonicalizeLotteryRetailer(retailer);
  if (canonicalRetailer.status !== 'ready') return canonicalRetailer;

  const extracted = extractExplicitLotteryApplicationId(evidence);
  const suppliedId = normalizeText(explicitApplicationId);
  if (suppliedId && extracted.status === 'ready' && suppliedId !== extracted.applicationId) {
    return { status: 'review', reasonCode: 'lottery-application-id-conflict' };
  }
  const applicationId = suppliedId || (extracted.status === 'ready' ? extracted.applicationId : '');
  if (!applicationId) return extracted;

  const identity = { retailerKey: canonicalRetailer.retailerKey, applicationId };
  const key = createLotteryBusinessEventKey({ kind, ...identity });
  if (key.status !== 'ready') return key;
  return { status: 'ready', businessEventIdentity: identity, businessEventKey: key.businessEventKey };
}

/** Resolve an explicit store and ID from the user's Chat report for the command API. */
export function resolveChatLotteryIdentity({ kind, retailer, reportText, applicationId } = {}) {
  return resolveIdentity({ kind, retailer, evidence: reportText, explicitApplicationId: applicationId });
}

/** Resolve a retailer and explicitly-labelled entry ID from transient Gmail fields. */
export function resolveGmailLotteryIdentity({ kind, subject, text } = {}) {
  const evidence = `${normalizeText(subject)}\n${normalizeText(text)}`;
  const searchableEvidence = retailerLookupKey(evidence);
  const matches = new Set();
  for (const [alias, retailerKey] of RETAILER_ALIASES) {
    const normalizedAlias = retailerLookupKey(alias);
    if (normalizedAlias && searchableEvidence.includes(normalizedAlias)) {
      matches.add(retailerKey);
    }
  }
  if (matches.size !== 1) {
    return { status: 'review', reasonCode: matches.size ? 'lottery-retailer-ambiguous' : 'lottery-retailer-unknown' };
  }
  const retailerKey = [...matches][0];
  return resolveIdentity({ kind, retailer: retailerKey, evidence });
}
