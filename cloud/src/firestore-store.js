import { validateState } from '../../v2/core.js';

const MAX_DOCUMENT_BYTES = 900_000;
const clone = (value) => JSON.parse(JSON.stringify(value));

export class RevisionConflict extends Error {
  constructor(revision) {
    super('revision conflict');
    this.name = 'RevisionConflict';
    this.currentRevision = revision;
  }
}

export class CanonicalNotInitialized extends Error {
  constructor() {
    super('canonical V2 state is not initialized');
    this.name = 'CanonicalNotInitialized';
  }
}

export class StateTooLarge extends Error {
  constructor() {
    super('V2 snapshot exceeds the configured Firestore document safety limit');
    this.name = 'StateTooLarge';
  }
}

function validateSnapshot(payload, mutationId, expectedRevision) {
  validateState(payload);
  if (!mutationId || payload.lastMutationId !== mutationId) {
    throw new Error('mutationId does not match the V2 snapshot');
  }
  if (Number(payload.revision) !== Number(expectedRevision) + 1) {
    throw new Error('revision must increment by one');
  }
  const bytes = Buffer.byteLength(JSON.stringify({ payload }), 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) throw new StateTooLarge();
}

function hasMutation(payload, mutationId) {
  return payload?.lastMutationId === mutationId
    || payload?.auditLog?.some((entry) => entry?.mutationId === mutationId) === true;
}

export function createFirestoreStore(db, documentPath = 'torecaVaultV2/canonical') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const ref = db.doc(documentPath);

  return {
    async read() {
      const snapshot = await ref.get();
      if (!snapshot.exists) return null;
      const value = snapshot.data();
      if (!value || value.schemaVersion !== 2 || !value.payload) {
        throw new Error('stored Firestore document is not a V2 canonical snapshot');
      }
      validateState(value.payload);
      return {
        payload: clone(value.payload),
        revision: Number(value.revision),
        lastMutationId: String(value.lastMutationId || '')
      };
    },

    async save({ expectedRevision, mutationId, payload }) {
      validateSnapshot(payload, mutationId, expectedRevision);

      const result = await db.runTransaction(async (transaction) => {
        const currentDoc = await transaction.get(ref);
        if (!currentDoc.exists) throw new CanonicalNotInitialized();
        const current = currentDoc.data();
        if (!current?.payload || current.schemaVersion !== 2) {
          throw new Error('stored Firestore document is not a V2 canonical snapshot');
        }
        if (hasMutation(current.payload, mutationId)) {
          return { duplicate: true, current: clone(current) };
        }
        if (Number(current.revision) !== Number(expectedRevision)) {
          throw new RevisionConflict(Number(current.revision));
        }

        transaction.set(ref, {
          schemaVersion: 2,
          revision: Number(payload.revision),
          lastMutationId: mutationId,
          payload: clone(payload),
          updatedAt: new Date().toISOString()
        });
        return { duplicate: false };
      });

      const confirmed = await this.read();
      if (!confirmed) throw new Error('V2 snapshot disappeared after write');
      if (result.duplicate) {
        return { ...confirmed, duplicate: true };
      }
      if (confirmed.lastMutationId !== mutationId
        || confirmed.revision !== Number(payload.revision)
        || JSON.stringify(confirmed.payload) !== JSON.stringify(payload)) {
        throw new Error('post-write canonical readback did not match the submitted V2 snapshot');
      }
      return { ...confirmed, duplicate: false };
    }
  };
}
