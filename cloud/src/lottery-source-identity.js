import { createLotteryBusinessEventKey } from './business-event-identity.js';

const MAX_INPUT_BYTES = 512 * 1024;
const ID_LINE = /^\s*(?:[・●*]\s*)?(?:応募(?:受付)?(?:番号|ID)|お?申(?:し)?込(?:み)?(?:受付)?(?:番号|ID)|エントリー(?:番号|ID)|application\s*(?:id|number))\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9._-]{2,79})\s*$/i;
const STORE_LINE = /^\s*(?:[・●*]\s*)?(?:店舗名|応募店舗|販売店|ショップ名|ストア名|store(?:\s*name)?)\s*:\s*(.{1,120}?)\s*$/i;
const REVIEW = (reasonCode) => ({ status: 'review', reasonCode });
const normalizedAlias = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('ja').replace(/\s+/g, ' ');

/**
 * Resolve an externally issued application ID and an allowlisted retailer alias
 * from a bounded Gmail subject/plain-text body. Never infer identity from a
 * product, date, sender, or an unlabelled number. This function does no I/O and
 * returns no raw message fields or application ID.
 *
 * The caller must configure reviewed aliases: { '表示店舗名': 'canonical-retailer-key' }.
 * Unknown/conflicting retailer or application IDs require manual review.
 */
export function resolveLotteryIdentityFromGmail({ kind, subject = '', text = '', retailerAliases = {} } = {}) {
  if (!['application', 'result', 'receipt'].includes(kind)) throw new TypeError('lottery event kind is invalid');
  if (typeof subject !== 'string' || typeof text !== 'string'
    || Buffer.byteLength(subject, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
    return REVIEW('lottery-identity-invalid');
  }
  if (!retailerAliases || typeof retailerAliases !== 'object' || Array.isArray(retailerAliases)) {
    throw new TypeError('retailer alias configuration is invalid');
  }
  const aliases = new Map();
  for (const [displayName, canonicalKey] of Object.entries(retailerAliases)) {
    if (typeof canonicalKey !== 'string' || !canonicalKey.trim()) {
      throw new TypeError('retailer alias configuration is invalid');
    }
    const alias = normalizedAlias(displayName);
    if (!alias || aliases.has(alias) && aliases.get(alias) !== canonicalKey) {
      throw new TypeError('retailer alias configuration conflicts');
    }
    aliases.set(alias, canonicalKey);
  }

  const ids = new Set();
  const retailers = new Set();
  let unrecognizedRetailer = false;
  const lines = (subject + '\n' + text).normalize('NFKC').split(/\r?\n/);
  for (const line of lines) {
    const id = ID_LINE.exec(line);
    if (id) ids.add(id[1]);
    const store = STORE_LINE.exec(line);
    if (store) {
      const canonical = aliases.get(normalizedAlias(store[1]));
      if (!canonical) unrecognizedRetailer = true;
      else retailers.add(canonical);
    }
  }
  if (ids.size > 1 || retailers.size > 1 || (retailers.size && unrecognizedRetailer)) {
    return REVIEW('lottery-identity-conflict');
  }
  if (unrecognizedRetailer) return REVIEW('lottery-retailer-unrecognized');
  if (ids.size !== 1 || retailers.size !== 1) return REVIEW('lottery-identity-incomplete');
  return createLotteryBusinessEventKey({
    kind,
    retailerKey: [...retailers][0],
    applicationId: [...ids][0]
  });
}
