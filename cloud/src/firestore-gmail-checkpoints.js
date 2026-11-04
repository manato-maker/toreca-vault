const SCAN_TYPES = new Set(['hourly', 'results']);
const DEFAULT_COLLECTION = 'torecaVaultV2/gmailScanCheckpoints/scans';

function scanTypeValue(value) {
  if (!SCAN_TYPES.has(value)) throw new TypeError('scanType must be hourly or results');
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer timestamp`);
  return value;
}

function normalizeCursor(cursor, scanType) {
  if (cursor == null) return null;
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new TypeError('cursor must be an object or null');
  const sinceMs = timestamp(cursor.sinceMs, 'cursor.sinceMs');
  const untilMs = timestamp(cursor.untilMs, 'cursor.untilMs');
  if (cursor.scanType !== scanType || untilMs <= sinceMs) throw new TypeError('cursor does not belong to this scan window');
  const pageToken = cursor.pageToken == null ? null : String(cursor.pageToken);
  if (pageToken && pageToken.length > 2048) throw new TypeError('pageToken is too long');
  return { sinceMs, untilMs, scanType, pageToken };
}

function sameCursor(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return left.sinceMs === right.sinceMs
    && left.untilMs === right.untilMs
    && left.scanType === right.scanType
    && (left.pageToken ?? null) === (right.pageToken ?? null);
}

function checkpointConflict() {
  const error = new Error('Gmail checkpoint changed during page processing');
  error.name = 'GmailCheckpointConflict';
  return error;
}

/** Persist only bounded scan metadata; Gmail message content is never stored here. */
export function createFirestoreGmailCheckpointStore(db, collectionPath = DEFAULT_COLLECTION, { clock = () => Date.now() } = {}) {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  if (typeof collectionPath !== 'string' || !collectionPath.trim()) throw new TypeError('collectionPath is required');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  const refFor = (scanType) => db.doc(`${collectionPath}/${scanTypeValue(scanType)}`);

  return {
    async load(scanType) {
      const ref = refFor(scanType);
      const snapshot = await ref.get();
      if (!snapshot.exists) return null;
      const data = snapshot.data();
      if (data.scanType !== scanType) throw new Error('Gmail checkpoint identity mismatch');
      const cursor = normalizeCursor(data.cursor ?? null, scanType);
      const lastSuccessfulAtMs = data.lastSuccessfulAtMs == null
        ? null
        : timestamp(data.lastSuccessfulAtMs, 'lastSuccessfulAtMs');
      return { cursor, lastSuccessfulAtMs };
    },

    async saveCursor(scanType, cursor, { expectedCursor = null, expectedLastSuccessfulAtMs = null } = {}) {
      scanTypeValue(scanType);
      const nextCursor = normalizeCursor(cursor, scanType);
      const expected = normalizeCursor(expectedCursor, scanType);
      const expectedLastSuccess = expectedLastSuccessfulAtMs == null
        ? null
        : timestamp(expectedLastSuccessfulAtMs, 'expectedLastSuccessfulAtMs');
      if (!nextCursor) throw new TypeError('saveCursor requires a cursor');
      const ref = refFor(scanType);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? snapshot.data() : null;
        const currentCursor = normalizeCursor(current?.cursor ?? null, scanType);
        const currentLastSuccess = current?.lastSuccessfulAtMs == null
          ? null
          : timestamp(current.lastSuccessfulAtMs, 'lastSuccessfulAtMs');
        if (!sameCursor(currentCursor, expected) || currentLastSuccess !== expectedLastSuccess) throw checkpointConflict();
        const nowMs = timestamp(clock(), 'clock()');
        transaction.set(ref, {
          schemaVersion: 1,
          scanType,
          cursor: nextCursor,
          lastSuccessfulAtMs: current?.lastSuccessfulAtMs == null
            ? null
            : timestamp(current.lastSuccessfulAtMs, 'lastSuccessfulAtMs'),
          updatedAtMs: nowMs
        });
        return { saved: true };
      });
    },

    async completeScan(scanType, lastSuccessfulAtMs, { expectedCursor, expectedLastSuccessfulAtMs = null } = {}) {
      scanTypeValue(scanType);
      const completedAt = timestamp(lastSuccessfulAtMs, 'lastSuccessfulAtMs');
      const expected = normalizeCursor(expectedCursor, scanType);
      const expectedLastSuccess = expectedLastSuccessfulAtMs == null
        ? null
        : timestamp(expectedLastSuccessfulAtMs, 'expectedLastSuccessfulAtMs');
      if (!expected) throw new TypeError('expectedCursor is required');
      const ref = refFor(scanType);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? snapshot.data() : null;
        const currentCursor = normalizeCursor(current?.cursor ?? null, scanType);
        if (currentCursor == null && Number(current?.lastSuccessfulAtMs) === completedAt) {
          return { saved: true, duplicate: true };
        }
        const currentLastSuccess = current?.lastSuccessfulAtMs == null
          ? null
          : timestamp(current.lastSuccessfulAtMs, 'lastSuccessfulAtMs');
        if (!sameCursor(currentCursor, expected) || currentLastSuccess !== expectedLastSuccess) throw checkpointConflict();
        const nowMs = timestamp(clock(), 'clock()');
        transaction.set(ref, {
          schemaVersion: 1,
          scanType,
          cursor: null,
          lastSuccessfulAtMs: completedAt,
          updatedAtMs: nowMs
        });
        return { saved: true, duplicate: false };
      });
    }
  };
}
