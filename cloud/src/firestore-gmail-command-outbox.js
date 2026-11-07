import { createHash } from 'node:crypto';

const VERSION = 1;
const KINDS = new Set(['application', 'result', 'receipt']);
const STATUSES = new Set(['ready', 'review', 'submitted']);
const clone = (value) => structuredClone(value);
function checkHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('messageIdHash is invalid');
}
function fingerprint(entry) {
  return createHash('sha256').update(JSON.stringify({ kind: entry.kind, requestId: entry.requestId, status: entry.status,
    reasonCode: entry.reasonCode || '', command: entry.command || null, businessEventKey: entry.businessEventKey || '' })).digest('hex');
}

/** Stores hashed Gmail IDs and explicit commands only; subject/body/raw message ID are never accepted. */
export function createFirestoreGmailCommandOutbox(db, collectionPath = 'torecaVaultV2/gmailCommandOutbox/messages') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') throw new TypeError('a Firestore client is required');
  const refFor = (hash) => { checkHash(hash); return db.doc(`${collectionPath}/${hash}`); };
  return {
    async recordOnce(entry) {
      checkHash(entry?.messageIdHash);
      if (!KINDS.has(entry.kind) || !STATUSES.has(entry.status) || typeof entry.requestId !== 'string' || !entry.requestId.startsWith('gmail:') || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs < 0) throw new TypeError('Gmail outbox entry is invalid');
      const ref = refFor(entry.messageIdHash), payloadHash = fingerprint(entry);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (snapshot.exists) {
          const current = snapshot.data();
          return current.messageIdHash === entry.messageIdHash && current.payloadHash === payloadHash ? { status: 'duplicate', currentStatus: current.status } : { status: 'collision' };
        }
        tx.create(ref, { schemaVersion: VERSION, ...clone(entry), payloadHash });
        return { status: 'recorded' };
      });
    },
    async get(hash) {
      const snapshot = await refFor(hash).get();
      if (!snapshot.exists) return null;
      const row = snapshot.data();
      if (row.schemaVersion !== VERSION || row.messageIdHash !== hash || !KINDS.has(row.kind) || !STATUSES.has(row.status)) throw new Error('Gmail outbox schema is invalid');
      return clone(row);
    },
    async markSubmitted(hash, resultCode) {
      const ref = refFor(hash);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return { status: 'missing' };
        const row = snapshot.data();
        if (row.status === 'submitted') return { status: 'duplicate' };
        if (row.status !== 'ready') return { status: row.status };
        tx.set(ref, { ...row, status: 'submitted', resultCode, updatedAtMs: Date.now() });
        return { status: 'submitted' };
      });
    },
    async markReview(hash, reasonCode) {
      const ref = refFor(hash);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return { status: 'missing' };
        const row = snapshot.data();
        if (row.status === 'submitted') return { status: 'submitted' };
        tx.set(ref, { ...row, status: 'review', reasonCode, updatedAtMs: Date.now() });
        return { status: 'review' };
      });
    }
  };
}
