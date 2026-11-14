import { createHash } from 'node:crypto';

const SCHEMA_VERSION = 1;
const FIRST_ROW = 2;
const MAX_NEXT_ROW = 100_002;

function validateRow(value, label) {
  if (!Number.isSafeInteger(value) || value < FIRST_ROW || value > MAX_NEXT_ROW) {
    throw new RangeError(`${label} is outside the allowed intake range`);
  }
}

/** Durable append-only scan cursor; stores no sheet cells or command data. */
export function createFirestoreGoogleSheetsIntakeCursorStore(db, spreadsheetId, collectionPath = 'torecaVaultNewAppIntakeCursors') {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
    throw new TypeError('spreadsheetId is invalid');
  }
  if (typeof collectionPath !== 'string' || !collectionPath.trim()) throw new TypeError('collectionPath is required');
  const id = createHash('sha256').update(spreadsheetId).digest('hex');
  const ref = db.collection(collectionPath).doc(id);

  function parse(data) {
    if (data === undefined) return { nextRow: FIRST_ROW, generation: 0 };
    if (!data || data.schemaVersion !== SCHEMA_VERSION) throw new Error('stored Sheets intake cursor has an unsupported schema');
    validateRow(data.nextRow, 'stored nextRow');
    if (!Number.isSafeInteger(data.generation) || data.generation < 0) throw new Error('stored Sheets intake cursor generation is invalid');
    if (!Number.isSafeInteger(data.updatedAtMs) || data.updatedAtMs < 0) throw new Error('stored Sheets intake cursor timestamp is invalid');
    return { nextRow: data.nextRow, generation: data.generation };
  }

  return {
    async read() {
      const snapshot = await ref.get();
      return parse(snapshot.exists ? snapshot.data() : undefined);
    },

    async advance({ expectedNextRow, nextRow, now = Date.now() } = {}) {
      validateRow(expectedNextRow, 'expectedNextRow');
      validateRow(nextRow, 'nextRow');
      if (nextRow <= expectedNextRow) throw new RangeError('nextRow must advance the cursor');
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative timestamp');
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = parse(snapshot.exists ? snapshot.data() : undefined);
        if (current.nextRow !== expectedNextRow) return false;
        transaction.set(ref, {
          schemaVersion: SCHEMA_VERSION,
          nextRow,
          generation: current.generation + 1,
          updatedAtMs: now
        });
        return true;
      });
    }
  };
}
