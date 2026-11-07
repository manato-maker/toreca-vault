import { createHash } from 'node:crypto';

const SCHEMA_VERSION = 1;
const IGNORE_REASONS = new Set(['not-card-related', 'not-result', 'not-lottery-mail']);

function validateMessageId(messageId) {
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 512
    || /[\u0000-\u001f\u007f]/.test(messageId)) {
    throw new TypeError('messageId is invalid');
  }
}

function normalizeClassification(value) {
  if (!value || typeof value !== 'object') throw new TypeError('classification is invalid');
  if (value.kind === 'application' || value.kind === 'result') return { kind: value.kind };
  if (value.kind === 'ignore' && IGNORE_REASONS.has(value.reason)) {
    return { kind: 'ignore', reason: value.reason };
  }
  throw new TypeError('classification is invalid');
}

function validateTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('nowMs must be a non-negative timestamp');
}

/** Persist only a hashed message ID and a small classifier outcome, never mail fields. */
export function createFirestoreGmailClassificationStore(db, collectionPath = 'torecaVaultV2/gmailClassifications/messages') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const refFor = (messageId) => {
    validateMessageId(messageId);
    const idHash = createHash('sha256').update(messageId).digest('hex');
    return { ref: db.doc(collectionPath + '/' + idHash), idHash };
  };

  return {
    async record(messageId, classification, { nowMs = Date.now() } = {}) {
      validateTimestamp(nowMs);
      const outcome = normalizeClassification(classification);
      const { ref, idHash } = refFor(messageId);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          const current = snapshot.data();
          const same = current.messageIdHash === idHash
            && current.kind === outcome.kind
            && (current.reason ?? null) === (outcome.reason ?? null);
          if (!same) {
            const error = new Error('Gmail classification outcome conflicts with an existing record');
            error.name = 'GmailClassificationConflict';
            throw error;
          }
          return { status: 'duplicate', outcome };
        }
        transaction.set(ref, {
          schemaVersion: SCHEMA_VERSION,
          messageIdHash: idHash,
          ...outcome,
          classifiedAtMs: nowMs
        });
        return { status: 'recorded', outcome };
      });
    },

    async get(messageId) {
      const { ref } = refFor(messageId);
      const snapshot = await ref.get();
      if (!snapshot.exists) return null;
      const data = snapshot.data();
      return {
        kind: data.kind,
        ...(data.reason ? { reason: data.reason } : {}),
        classifiedAtMs: data.classifiedAtMs
      };
    }
  };
}
