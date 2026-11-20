import { createHash } from 'node:crypto';

const VERSION = 1;
const KEY_PATTERN = /^v2\/\d{4}-\d{2}-\d{2}\/revision-\d+-[a-f0-9]{64}\.json$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

function validateKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new TypeError('backup key is invalid');
  return key;
}

function keyHash(key) {
  return createHash('sha256').update(validateKey(key)).digest('hex');
}

function validateFileId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Drive file ID is invalid');
  return id;
}

/** Atomically maps a stable backup key to one pre-generated Drive file ID. */
export function createFirestoreBackupIdRegistry(db, collectionPath = 'torecaVaultV2/backupDriveIds/keys', clock = () => Date.now()) {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const refFor = (hash) => db.doc(`${collectionPath}/${hash}`);

  return {
    async get(key) {
      const hash = keyHash(key);
      const snapshot = await refFor(hash).get();
      if (!snapshot.exists) return null;
      const row = snapshot.data();
      if (row.schemaVersion !== VERSION || row.keyHash !== hash) throw new Error('backup ID registry schema is invalid');
      return validateFileId(row.fileId);
    },

    async getOrCreate(key, candidateFileId) {
      const hash = keyHash(key);
      const proposedId = validateFileId(candidateFileId);
      const createdAtMs = clock();
      if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new TypeError('clock must return a non-negative timestamp');
      return db.runTransaction(async (transaction) => {
        const ref = refFor(hash);
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          const row = snapshot.data();
          if (row.schemaVersion !== VERSION || row.keyHash !== hash) throw new Error('backup ID registry schema is invalid');
          return validateFileId(row.fileId);
        }
        transaction.create(ref, {
          schemaVersion: VERSION,
          keyHash: hash,
          fileId: proposedId,
          createdAtMs
        });
        return proposedId;
      });
    }
  };
}
