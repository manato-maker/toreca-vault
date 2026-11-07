import { createHash, randomUUID } from 'node:crypto';

const ALLOWED_TYPES = new Set([
  'purchase', 'sale', 'lottery', 'lottery-bulk', 'open-packs',
  'lottery-result-exact', 'lottery-receipt', 'pokemoncenter-spouse-result',
  'repair-receipt-sale'
]);
const MAX_COMMAND_BYTES = 20_000;
const clone = (value) => structuredClone(value);
const safeResultCode = (value) => {
  const code = String(value || '');
  return /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(code) ? code : 'worker-result';
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function businessFingerprint(command) {
  const businessCommand = { ...command };
  delete businessCommand.requestId;
  return createHash('sha256').update(canonicalJson(businessCommand)).digest('hex');
}

function normalizeBusinessEventKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('businessEventKey must be a string');
  const key = value.trim();
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError('businessEventKey must be 1 to 256 printable characters');
  }
  return key;
}

function validateCommand(requestId, command) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
    throw new TypeError('requestId must be a non-empty string of at most 200 characters');
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('command must be an object');
  }
  if (String(command.requestId || '').trim() !== requestId.trim()) {
    throw new TypeError('requestId does not match command');
  }
  if (!ALLOWED_TYPES.has(String(command.type || ''))) throw new TypeError('unsupported command type');
  const bytes = Buffer.byteLength(JSON.stringify(command), 'utf8');
  if (bytes > MAX_COMMAND_BYTES) throw new RangeError('command exceeds the 20000-byte limit');
}

function safeNow(now) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative timestamp');
}

/** Durable, create-once V2 command queue. Queue payloads remain available for retry and audit. */
export function createFirestoreCommandQueue(db, collectionPath = 'torecaVaultV2/commandQueue/commands') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const refFor = (requestId) => {
    const id = createHash('sha256').update(requestId.trim()).digest('hex');
    return db.doc(`${collectionPath}/${id}`);
  };
  const refForBusinessEvent = (businessEventKeyHash) => db.doc(`${collectionPath}/_event_${businessEventKeyHash}`);

  return {
    async enqueue({ requestId, command, businessEventKey, now = Date.now() }) {
      safeNow(now);
      validateCommand(requestId, command);
      const ref = refFor(requestId);
      const payloadHash = createHash('sha256').update(canonicalJson(command)).digest('hex');
      const normalizedEventKey = normalizeBusinessEventKey(businessEventKey);
      const businessEventKeyHash = normalizedEventKey
        ? createHash('sha256').update(normalizedEventKey).digest('hex') : '';
      const businessPayloadHash = normalizedEventKey ? businessFingerprint(command) : '';
      const eventRef = businessEventKeyHash ? refForBusinessEvent(businessEventKeyHash) : null;
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const eventSnapshot = eventRef ? await transaction.get(eventRef) : null;
        if (snapshot.exists) {
          const current = snapshot.data();
          if (current.requestId !== requestId.trim() || current.payloadHash !== payloadHash
            || (current.businessEventKeyHash || '') !== businessEventKeyHash) {
            return { status: 'collision', accepted: false };
          }
          if (eventSnapshot?.exists) {
            const event = eventSnapshot.data();
            if (event.requestId !== requestId.trim() || event.businessPayloadHash !== businessPayloadHash) {
              return { status: 'business-event-collision', accepted: false };
            }
          } else if (eventRef) {
            transaction.create(eventRef, {
              recordType: 'business-event-index',
              businessEventKeyHash,
              businessPayloadHash,
              requestId: requestId.trim(),
              createdAtMs: current.createdAtMs
            });
          }
          return { status: current.status, accepted: true, duplicate: true };
        }
        if (eventSnapshot?.exists) {
          const event = eventSnapshot.data();
          if (event.businessEventKeyHash !== businessEventKeyHash
            || event.businessPayloadHash !== businessPayloadHash) {
            return { status: 'business-event-collision', accepted: false };
          }
          return {
            status: 'duplicate', accepted: false, duplicate: true,
            businessDuplicate: true, existingRequestId: event.requestId
          };
        }
        transaction.create(ref, {
          requestId: requestId.trim(),
          command: clone(command),
          payloadHash,
          ...(businessEventKeyHash ? { businessEventKeyHash } : {}),
          status: 'pending',
          attempts: 0,
          createdAtMs: now,
          updatedAtMs: now,
          leaseExpiresAtMs: 0,
          claimToken: ''
        });
        if (eventRef) {
          transaction.create(eventRef, {
            recordType: 'business-event-index',
            businessEventKeyHash,
            businessPayloadHash,
            requestId: requestId.trim(),
            createdAtMs: now
          });
        }
        return { status: 'pending', accepted: true, duplicate: false };
      });
    },

    async claim(requestId, { now = Date.now(), leaseMs = 120_000, maxAttempts = 3 } = {}) {
      safeNow(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer');
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
      const ref = refFor(requestId);
      const claimToken = randomUUID();
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return { status: 'missing', claimed: false };
        const current = snapshot.data();
        if (current.status === 'done' || current.status === 'review') return { status: current.status, claimed: false };
        if (current.status === 'processing' && Number(current.leaseExpiresAtMs) > now) {
          return { status: 'busy', claimed: false };
        }
        const attempts = Number(current.attempts || 0);
        if (attempts >= maxAttempts) {
          transaction.set(ref, { ...current, status: 'review', resultCode: 'attempt-limit', claimToken: '', leaseExpiresAtMs: 0, updatedAtMs: now });
          return { status: 'exhausted', claimed: false };
        }
        transaction.set(ref, {
          ...current,
          status: 'processing',
          attempts: attempts + 1,
          claimToken,
          leaseExpiresAtMs: now + leaseMs,
          updatedAtMs: now
        });
        return { status: 'claimed', claimed: true, claimToken, attempts: attempts + 1, command: clone(current.command) };
      });
    },

    async finish(requestId, claimToken, { outcome, resultCode = '', now = Date.now() } = {}) {
      safeNow(now);
      if (!['done', 'pending', 'review'].includes(outcome)) throw new TypeError('outcome must be done, pending, or review');
      const ref = refFor(requestId);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return { status: 'missing', updated: false };
        const current = snapshot.data();
        if (current.status !== 'processing' || current.claimToken !== claimToken) {
          return { status: 'lease-lost', updated: false };
        }
        transaction.set(ref, {
          ...current,
          status: outcome,
          resultCode: safeResultCode(resultCode),
          claimToken: '',
          leaseExpiresAtMs: 0,
          updatedAtMs: now
        });
        return { status: outcome, updated: true };
      });
    },

    async inspect(requestId) {
      const snapshot = await refFor(requestId).get();
      return snapshot.exists ? clone(snapshot.data()) : null;
    },

    async listPending({ limit = 10 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('pending command limit must be from 1 to 50');
      if (typeof db.collection !== 'function') throw new TypeError('Firestore collection queries are required');
      const snapshot = await db.collection(collectionPath).where('status', '==', 'pending').limit(limit).get();
      return snapshot.docs.map((document) => {
        const row = document.data();
        if (typeof row.requestId !== 'string' || !row.requestId.trim()) throw new Error('pending command row has an invalid request ID');
        return { requestId: row.requestId };
      });
    },

    async summarize() {
      if (typeof db.collection !== 'function') throw new TypeError('Firestore collection queries are required for queue summary');
      const collection = db.collection(collectionPath);
      const [unprocessedSnapshot, reviewSnapshot] = await Promise.all([
        collection.where('status', 'in', ['pending', 'processing']).count().get(),
        collection.where('status', '==', 'review').count().get()
      ]);
      const unprocessedCount = unprocessedSnapshot?.data?.().count;
      const reviewCount = reviewSnapshot?.data?.().count;
      if (!Number.isSafeInteger(unprocessedCount) || unprocessedCount < 0
        || !Number.isSafeInteger(reviewCount) || reviewCount < 0) {
        throw new Error('Firestore returned an invalid queue summary');
      }
      return { unprocessedCount, reviewCount };
    }
  };
}

