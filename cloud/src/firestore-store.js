import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

const MAX_DOCUMENT_BYTES = 900_000;
const MAX_SEGMENT_BYTES = 650_000;
const MAX_TRANSACTION_PAYLOAD_BYTES = 7_000_000;
const MAX_SEGMENTS = 400;
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
    super('V2 snapshot exceeds the configured Firestore transaction safety limits');
    this.name = 'StateTooLarge';
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function hasMutation(payload, mutationId) {
  return payload?.lastMutationId === mutationId
    || payload?.auditLog?.some((entry) => entry?.mutationId === mutationId) === true;
}

function checkedSnapshot(payload, mutationId, expectedRevision) {
  validateState(payload);
  if (!mutationId || payload.lastMutationId !== mutationId) {
    throw new Error('mutationId does not match the V2 snapshot');
  }
  if (Number(payload.revision) !== Number(expectedRevision) + 1) {
    throw new Error('revision must increment by one');
  }
  const serialized = canonicalStringify(payload);
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > MAX_TRANSACTION_PAYLOAD_BYTES) throw new StateTooLarge();
  return {
    serialized,
    payloadBytes,
    payloadHash: createHash('sha256').update(serialized).digest('hex')
  };
}

function segmentDocumentId(key, index) {
  const keyHash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return 'array_' + keyHash + '_' + String(index).padStart(4, '0');
}

function chunkArray(key, items, revision) {
  const chunks = [];
  let current = [];
  const sizeOf = (index, values) => Buffer.byteLength(JSON.stringify({
    schemaVersion: 1, revision, key, index, items: values
  }), 'utf8');

  for (const item of items) {
    const candidate = [...current, item];
    if (sizeOf(chunks.length, candidate) <= MAX_SEGMENT_BYTES) {
      current = candidate;
      continue;
    }
    if (!current.length || sizeOf(chunks.length, [item]) > MAX_SEGMENT_BYTES) throw new StateTooLarge();
    chunks.push(current);
    current = [item];
  }
  if (current.length) chunks.push(current);
  return chunks.map((values, index) => ({
    id: segmentDocumentId(key, index),
    data: { schemaVersion: 1, revision, key, index, items: values }
  }));
}

function buildStorage(payload, checked) {
  const legacy = {
    schemaVersion: 2,
    revision: Number(payload.revision),
    lastMutationId: payload.lastMutationId,
    payload: clone(payload),
    updatedAt: new Date().toISOString()
  };
  if (Buffer.byteLength(JSON.stringify(legacy), 'utf8') <= MAX_DOCUMENT_BYTES) {
    return { format: 'single', root: legacy, segments: [] };
  }

  const inlinePayload = {};
  const payloadOrder = Object.keys(payload);
  const arrayChunkCounts = {};
  const segments = [];
  for (const key of payloadOrder) {
    const value = payload[key];
    if (!Array.isArray(value)) {
      inlinePayload[key] = clone(value);
      continue;
    }
    const chunks = chunkArray(key, value, Number(payload.revision));
    arrayChunkCounts[key] = chunks.length;
    segments.push(...chunks);
  }
  if (segments.length > MAX_SEGMENTS) throw new StateTooLarge();

  const root = {
    schemaVersion: 2,
    storageFormat: 'chunked-v1',
    revision: Number(payload.revision),
    lastMutationId: payload.lastMutationId,
    inlinePayload,
    payloadOrder,
    arrayChunkCounts,
    segmentIds: segments.map(({ id }) => id),
    payloadBytes: checked.payloadBytes,
    payloadHash: checked.payloadHash,
    updatedAt: new Date().toISOString()
  };
  if (Buffer.byteLength(JSON.stringify(root), 'utf8') > MAX_DOCUMENT_BYTES) throw new StateTooLarge();
  return { format: 'chunked-v1', root, segments };
}

function reconstructPayload(root, segmentSnapshots) {
  if (!Array.isArray(root.payloadOrder) || !Array.isArray(root.segmentIds)
    || !root.arrayChunkCounts || !root.inlinePayload) {
    throw new Error('stored Firestore chunk manifest is invalid');
  }
  const arrays = {};
  const expectedChunks = {};
  for (const [key, countValue] of Object.entries(root.arrayChunkCounts)) {
    const count = Number(countValue);
    if (!Number.isInteger(count) || count < 0) throw new Error('stored Firestore chunk count is invalid');
    arrays[key] = [];
    expectedChunks[key] = count;
  }
  if (segmentSnapshots.length !== root.segmentIds.length
    || root.segmentIds.length !== Object.values(expectedChunks).reduce((sum, count) => sum + count, 0)) {
    throw new Error('stored Firestore chunk manifest length is invalid');
  }

  const byKey = Object.fromEntries(Object.keys(arrays).map((key) => [key, []]));
  for (let position = 0; position < segmentSnapshots.length; position += 1) {
    const snapshot = segmentSnapshots[position];
    if (!snapshot.exists) throw new Error('stored Firestore snapshot is missing a chunk');
    const segment = snapshot.data();
    if (!segment || segment.schemaVersion !== 1
      || Number(segment.revision) !== Number(root.revision)
      || typeof segment.key !== 'string' || !Number.isInteger(segment.index) || segment.index < 0
      || !Array.isArray(segment.items) || !byKey[segment.key]
      || root.segmentIds[position] !== segmentDocumentId(segment.key, segment.index)) {
      throw new Error('stored Firestore chunk is invalid');
    }
    byKey[segment.key].push(segment);
  }

  for (const [key, expectedCount] of Object.entries(expectedChunks)) {
    const chunks = byKey[key].sort((left, right) => left.index - right.index);
    if (chunks.length !== expectedCount) throw new Error('stored Firestore chunk count does not match manifest');
    chunks.forEach((segment, index) => {
      if (segment.index !== index) throw new Error('stored Firestore chunk sequence is incomplete');
      arrays[key].push(...segment.items);
    });
  }

  const payload = {};
  for (const key of root.payloadOrder) {
    if (Object.hasOwn(arrays, key)) payload[key] = arrays[key];
    else if (Object.hasOwn(root.inlinePayload, key)) payload[key] = root.inlinePayload[key];
    else throw new Error('stored Firestore payload field is missing');
  }
  validateState(payload);
  const serialized = canonicalStringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') !== Number(root.payloadBytes)
    || createHash('sha256').update(serialized).digest('hex') !== root.payloadHash) {
    throw new Error('stored Firestore snapshot hash does not match');
  }
  return payload;
}
export function createFirestoreStore(db, documentPath = 'torecaVaultV2/canonical') {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  const ref = db.doc(documentPath);
  const segmentPath = documentPath + '/segments';

  async function readInside(transaction) {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const value = snapshot.data();
    if (!value || value.schemaVersion !== 2) {
      throw new Error('stored Firestore document is not a V2 canonical snapshot');
    }
    if (value.storageFormat !== 'chunked-v1') {
      if (!value.payload) throw new Error('stored Firestore document is not a V2 canonical snapshot');
      validateState(value.payload);
      return {
        payload: clone(value.payload),
        revision: Number(value.revision),
        lastMutationId: String(value.lastMutationId || '')
      };
    }
    if (value.segmentIds.length > MAX_SEGMENTS) throw new Error('stored Firestore chunk manifest exceeds limits');
    const refs = value.segmentIds.map((id) => db.doc(segmentPath + '/' + id));
    const segmentSnapshots = [];
    for (const segmentRef of refs) segmentSnapshots.push(await transaction.get(segmentRef));
    const payload = reconstructPayload(value, segmentSnapshots);
    return {
      payload,
      revision: Number(value.revision),
      lastMutationId: String(value.lastMutationId || '')
    };
  }

  return {
    async read() {
      return db.runTransaction((transaction) => readInside(transaction));
    },

    /**
     * Initialize an empty, explicitly selected Firestore target from a validated V2 payload.
     * This is intentionally separate from save(): ordinary mutation paths never create a baseline.
     */
    async initializeFromSnapshot(payload) {
      validateState(payload);
      const serialized = canonicalStringify(payload);
      const payloadBytes = Buffer.byteLength(serialized, 'utf8');
      if (payloadBytes > MAX_TRANSACTION_PAYLOAD_BYTES) throw new StateTooLarge();
      const checked = {
        serialized,
        payloadBytes,
        payloadHash: createHash('sha256').update(serialized).digest('hex')
      };
      const next = buildStorage(payload, checked);
      if (1 + next.segments.length > 500) throw new StateTooLarge();

      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(ref);
        if (current.exists) throw new Error('canonical Firestore state is already initialized');
        for (const segment of next.segments) {
          transaction.set(db.doc(segmentPath + '/' + segment.id), segment.data);
        }
        transaction.create(ref, next.root);
      });

      const confirmed = await this.read();
      if (!confirmed || canonicalStringify(confirmed.payload) !== serialized
        || confirmed.revision !== Number(payload.revision)
        || confirmed.lastMutationId !== String(payload.lastMutationId || '')) {
        throw new Error('staging snapshot initialization readback did not match');
      }
      return { ...confirmed, duplicate: false };
    },

    async save({ expectedRevision, mutationId, payload }) {
      const checked = checkedSnapshot(payload, mutationId, expectedRevision);
      const existing = await this.read();
      if (!existing) throw new CanonicalNotInitialized();
      if (hasMutation(existing.payload, mutationId)) return { ...existing, duplicate: true };

      const next = buildStorage(payload, checked);
      const result = await db.runTransaction(async (transaction) => {
        const currentDoc = await transaction.get(ref);
        if (!currentDoc.exists) throw new CanonicalNotInitialized();
        const current = currentDoc.data();
        if (!current || current.schemaVersion !== 2) {
          throw new Error('stored Firestore document is not a V2 canonical snapshot');
        }
        if (current.lastMutationId === mutationId) return { duplicate: true };
        if (Number(current.revision) !== Number(expectedRevision)) {
          throw new RevisionConflict(Number(current.revision));
        }

        const oldSegmentIds = current.storageFormat === 'chunked-v1' && Array.isArray(current.segmentIds)
          ? current.segmentIds : [];
        if (1 + next.segments.length + Math.max(0, oldSegmentIds.length - next.segments.length) > 500) {
          throw new StateTooLarge();
        }
        for (const segment of next.segments) {
          transaction.set(db.doc(segmentPath + '/' + segment.id), segment.data);
        }
        const nextIds = new Set(next.segments.map(({ id }) => id));
        for (const id of oldSegmentIds) {
          if (!nextIds.has(id)) transaction.delete(db.doc(segmentPath + '/' + id));
        }
        transaction.set(ref, next.root);
        return { duplicate: false };
      });

      const confirmed = await this.read();
      if (!confirmed) throw new Error('V2 snapshot disappeared after write');
      if (result.duplicate) return { ...confirmed, duplicate: true };
      if (confirmed.lastMutationId !== mutationId
        || confirmed.revision !== Number(payload.revision)
        || canonicalStringify(confirmed.payload) !== canonicalStringify(payload)) {
        throw new Error('post-write canonical readback did not match the submitted V2 snapshot');
      }
      return { ...confirmed, duplicate: false };
    }
  };
}


