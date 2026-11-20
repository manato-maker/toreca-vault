import { createHash, randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);

function validateKey(jobKey) {
  if (typeof jobKey !== 'string' || !jobKey.trim() || jobKey.length > 512) {
    throw new TypeError('jobKey must be a non-empty string of at most 512 characters');
  }
}

function validateClock(now) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative timestamp');
}

function safeErrorCode(error) {
  const name = String(error?.name || 'WorkerError');
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? name : 'WorkerError';
}

/** Firestore-backed lease/idempotency ledger. It stores no message or command bodies. */
export function createFirestoreJobLedger(db, collectionPath = 'torecaVaultV2/jobLedger/jobs') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const refFor = (jobKey) => {
    validateKey(jobKey);
    const id = createHash('sha256').update(jobKey).digest('hex');
    return db.doc(`${collectionPath}/${id}`);
  };

  return {
    async claim(jobKey, { now = Date.now(), leaseMs = 120_000, maxAttempts = 3 } = {}) {
      validateClock(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer');
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
      const ref = refFor(jobKey);
      const claimToken = randomUUID();
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? snapshot.data() : null;
        if (current?.status === 'completed') return { status: 'completed', claimed: false };
        if (current?.status === 'running' && Number(current.leaseExpiresAtMs) > now) {
          return { status: 'busy', claimed: false };
        }
        const attempts = Number(current?.attempts || 0);
        if (attempts >= maxAttempts) return { status: 'exhausted', claimed: false };
        const next = {
          status: 'running',
          attempts: attempts + 1,
          claimToken,
          leaseExpiresAtMs: now + leaseMs,
          createdAtMs: Number(current?.createdAtMs || now),
          updatedAtMs: now,
          expireAt: new Date(now + 90 * 24 * 60 * 60 * 1000)
        };
        transaction.set(ref, next);
        return { status: 'claimed', claimed: true, claimToken, attempts: next.attempts };
      });
    },

    async complete(jobKey, claimToken, { now = Date.now() } = {}) {
      validateClock(now);
      if (typeof claimToken !== 'string' || !claimToken) throw new TypeError('claimToken is required');
      const ref = refFor(jobKey);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('job lease does not exist');
        const current = snapshot.data();
        if (current.status === 'completed') return { status: 'completed', duplicate: true };
        if (current.status !== 'running' || current.claimToken !== claimToken) {
          throw new Error('job lease was lost or superseded');
        }
        transaction.set(ref, {
          ...current,
          status: 'completed',
          claimToken: '',
          leaseExpiresAtMs: 0,
          updatedAtMs: now
        });
        return { status: 'completed', duplicate: false };
      });
    },

    async fail(jobKey, claimToken, error, { now = Date.now(), maxAttempts = 3 } = {}) {
      validateClock(now);
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
      const ref = refFor(jobKey);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('job lease does not exist');
        const current = snapshot.data();
        if (current.status !== 'running' || current.claimToken !== claimToken) {
          throw new Error('job lease was lost or superseded');
        }
        const status = Number(current.attempts) >= maxAttempts ? 'dead' : 'retry';
        transaction.set(ref, {
          ...current,
          status,
          claimToken: '',
          leaseExpiresAtMs: 0,
          lastErrorCode: safeErrorCode(error),
          updatedAtMs: now
        });
        return { status, attempts: Number(current.attempts) };
      });
    },

    async inspect(jobKey) {
      const snapshot = await refFor(jobKey).get();
      return snapshot.exists ? clone(snapshot.data()) : null;
    }
  };
}

