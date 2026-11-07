import { createHash } from 'node:crypto';

const EVENT_KINDS = new Set(['application', 'result', 'receipt']);
const MAX_RETAILER_KEY_LENGTH = 120;
const MAX_APPLICATION_ID_LENGTH = 200;

function normalize(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Build a source-independent lottery event key from an explicit external
 * application ID. Missing or malformed identity must go to manual review.
 */
export function createLotteryBusinessEventKey({ kind, retailerKey, applicationId } = {}) {
  if (!EVENT_KINDS.has(kind)) throw new TypeError('lottery event kind is invalid');
  const retailer = normalize(retailerKey).toLocaleLowerCase('ja').replace(/\s+/g, ' ');
  const application = normalize(applicationId);
  if (!retailer || !application) {
    return { status: 'review', reasonCode: 'lottery-identity-incomplete' };
  }
  if (retailer.length > MAX_RETAILER_KEY_LENGTH || application.length > MAX_APPLICATION_ID_LENGTH
    || hasControlCharacters(retailer) || hasControlCharacters(application)) {
    return { status: 'review', reasonCode: 'lottery-identity-invalid' };
  }
  const canonical = JSON.stringify(['toreca-vault-lottery-event', 1, kind, retailer, application]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { status: 'ready', businessEventKey: `lottery:v1:${digest}` };
}
