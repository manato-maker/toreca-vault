import { createHash } from 'node:crypto';
import { createLotteryBusinessEventKey } from './business-event-identity.js';

const KIND_TO_COMMAND = new Map([['application', 'lottery'], ['result', 'lottery-result-exact'], ['receipt', 'lottery-receipt']]);
const COMMAND_FIELDS = new Map([
  ['application', new Set(['type', 'title', 'product', 'store', 'status', 'applicationDate', 'deadline', 'resultDate', 'receiveDeadline', 'owner', 'evidenceType'])],
  ['result', new Set(['type', 'title', 'product', 'store', 'owner', 'status', 'resultDate'])],
  ['receipt', new Set(['type', 'title', 'product', 'store', 'owner', 'receivedDate', 'date'])]
]);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const clone = (value) => structuredClone(value);

function messageHash(messageId) {
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 512 || /[\u0000-\u001f\u007f]/.test(messageId)) throw new TypeError('messageId is invalid');
  return createHash('sha256').update(messageId).digest('hex');
}
function validCommand(kind, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || draft.type !== KIND_TO_COMMAND.get(kind)) return false;
  const allowedFields = COMMAND_FIELDS.get(kind);
  if (Object.keys(draft).some((field) => !allowedFields.has(field))) return false;
  if (Object.entries(draft).some(([field, value]) => typeof value !== 'string' || value.length > (field === 'title' || field === 'product' ? 200 : 120) || /[\u0000-\u001f\u007f]/.test(value))) return false;
  if (!String(draft.title || draft.product || '').trim() || !String(draft.store || '').trim()) return false;
  if (draft.title && draft.product && draft.title.normalize('NFKC').trim() !== draft.product.normalize('NFKC').trim()) return false;
  if (kind === 'application') return ['応募済', '応募前'].includes(String(draft.status || '応募済'))
    && isDate(draft.applicationDate) && ['deadline', 'resultDate', 'receiveDeadline'].every((field) => !draft[field] || isDate(draft[field]));
  if (kind === 'result') return ['当選', '落選'].includes(String(draft.status || '')) && isDate(draft.resultDate);
  if (draft.receivedDate && draft.date && draft.receivedDate !== draft.date) return false;
  return isDate(draft.receivedDate || draft.date);
}
function eventKey(kind, identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some((key) => !['retailerKey', 'applicationId'].includes(key))) return null;
  const resolved = createLotteryBusinessEventKey({ ...identity, kind });
  return resolved.status === 'ready' ? resolved.businessEventKey : null;
}

/** Outbox writes first, then sends to the idempotent command queue using a stable hashed-mail requestId. */
export function createGmailCommandOutbox({ store, commandQueue } = {}) {
  if (!store || !['recordOnce', 'get', 'markSubmitted', 'markReview', 'approveReview'].every((m) => typeof store[m] === 'function')) throw new TypeError('a durable Gmail outbox store is required');
  if (!commandQueue || typeof commandQueue.enqueue !== 'function') throw new TypeError('a durable command queue is required');

  async function deliver(entry) {
    if (entry.status !== 'ready') return { status: entry.status, submitted: entry.status === 'submitted' };
    const queued = await commandQueue.enqueue({ requestId: entry.requestId, command: clone(entry.command), businessEventKey: entry.businessEventKey });
    if (!queued || ['collision', 'business-event-collision'].includes(queued.status)) {
      await store.markReview(entry.messageIdHash, 'queue-conflict');
      return { status: 'review', submitted: false, reasonCode: 'queue-conflict' };
    }
    const code = queued.businessDuplicate ? 'cross-source-duplicate' : queued.duplicate ? 'request-replay' : 'queued';
    await store.markSubmitted(entry.messageIdHash, code);
    return { status: 'submitted', submitted: true, duplicate: Boolean(queued.duplicate || queued.businessDuplicate) };
  }

  return {
    async record({ messageId, classification, commandDraft, businessEventIdentity, nowMs = Date.now() } = {}) {
      const hash = messageHash(messageId);
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs is invalid');
      if (!classification || !['application', 'result', 'receipt'].includes(classification.kind)) return { status: 'ignored', submitted: false };
      const requestId = `gmail:${hash.slice(0, 32)}`;
      const key = eventKey(classification.kind, businessEventIdentity);
      if (!key || !validCommand(classification.kind, commandDraft)) {
        const review = { messageIdHash: hash, requestId, kind: classification.kind, status: 'review', reasonCode: 'command-evidence-incomplete', createdAtMs: nowMs };
        await store.recordOnce(review);
        return { status: 'review', submitted: false, reasonCode: review.reasonCode };
      }
      const command = Object.fromEntries(Object.entries(clone(commandDraft)).map(([key, value]) => [key, value]));
      command.requestId = requestId;
      const row = { messageIdHash: hash, requestId, kind: classification.kind, status: 'ready', command, businessEventKey: key, createdAtMs: nowMs };
      const saved = await store.recordOnce(row);
      if (saved.status === 'collision') {
        await store.markReview(hash, 'outbox-conflict');
        return { status: 'review', submitted: false, reasonCode: 'outbox-conflict' };
      }
      return deliver((await store.get(hash)) || row);
    },
    async retry(messageId) {
      const entry = await store.get(messageHash(messageId));
      return entry ? deliver(entry) : { status: 'missing', submitted: false };
    },
    async approveReview({ messageId, expectedPayloadHash, confirmed, commandDraft, businessEventIdentity, nowMs = Date.now() } = {}) {
      if (confirmed !== true) return { status: 'review', submitted: false, reasonCode: 'explicit-confirmation-required' };
      const hash = messageHash(messageId);
      if (!/^[a-f0-9]{64}$/.test(String(expectedPayloadHash || ''))) return { status: 'review', submitted: false, reasonCode: 'review-version-required' };
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs is invalid');
      const entry = await store.get(hash);
      if (!entry) return { status: 'missing', submitted: false };
      if (entry.status !== 'review') return { status: entry.status, submitted: entry.status === 'submitted' };
      if (!validCommand(entry.kind, commandDraft)) return { status: 'review', submitted: false, reasonCode: 'command-evidence-incomplete' };
      const key = eventKey(entry.kind, businessEventIdentity);
      if (!key) return { status: 'review', submitted: false, reasonCode: 'business-identity-incomplete' };
      const command = clone(commandDraft);
      command.requestId = entry.requestId;
      const approved = await store.approveReview({ messageIdHash: hash, expectedPayloadHash, command, businessEventKey: key, nowMs });
      if (approved.status !== 'ready') return { status: approved.status, submitted: false, reasonCode: approved.status === 'stale' ? 'review-version-changed' : undefined };
      return deliver((await store.get(hash)) || { ...entry, status: 'ready', command, businessEventKey: key });
    }
  };
}
