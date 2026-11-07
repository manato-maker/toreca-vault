import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_ARTIFACT_BYTES = 7_500_000;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Backup payload is not JSON serializable');
  return encoded;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function asJsonSnapshot(snapshot) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(snapshot));
  } catch {
    throw new Error('Snapshot is not JSON serializable');
  }
  if (!copy || !Number.isSafeInteger(copy.revision) || copy.revision < 0) {
    throw new Error('Snapshot revision must be a nonnegative safe integer');
  }
  validateState(copy);
  return copy;
}

function metadataHashInput(artifact) {
  return canonical({
    backupSchemaVersion: artifact.backupSchemaVersion,
    createdAt: artifact.createdAt,
    revision: artifact.revision,
    payloadHash: artifact.payloadHash
  });
}

function encodedSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function inventorySummary(snapshot) {
  let quantity = 0;
  let knownCost = 0;
  let unknownCostLots = 0;
  for (const lot of snapshot.inventoryLots) {
    const qty = Number(lot.quantity);
    quantity += qty;
    if (lot.unitCost === null || lot.unitCost === undefined || lot.unitCost === '') {
      unknownCostLots += 1;
      continue;
    }
    const unitCost = Number(lot.unitCost);
    if (!Number.isFinite(unitCost)) throw new Error('Inventory cost is not finite');
    knownCost += qty * unitCost;
  }
  return { totalQuantity: quantity, knownAcquisitionCost: knownCost, unknownCostLots };
}

function countsSummary(snapshot) {
  return {
    transactions: snapshot.transactions.length,
    inventoryLots: snapshot.inventoryLots.length,
    lotteries: snapshot.lotteries.length,
    marketQuotes: snapshot.marketQuotes.length,
    auditLogEntries: snapshot.auditLog.length
  };
}

export function createBackupArtifact(snapshot, { createdAt = new Date() } = {}) {
  const payload = asJsonSnapshot(snapshot);
  const timestamp = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('createdAt must be an ISO-8601 timestamp');
  }
  const artifact = {
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: timestamp,
    revision: payload.revision,
    payloadHash: sha256(canonical(payload)),
    payload
  };
  artifact.artifactHash = sha256(metadataHashInput(artifact));
  if (encodedSize(artifact) > MAX_BACKUP_ARTIFACT_BYTES) throw new Error('Backup artifact exceeds size limit');
  return artifact;
}

export function verifyBackupArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('Backup artifact must be an object');
  if (encodedSize(artifact) > MAX_BACKUP_ARTIFACT_BYTES) throw new Error('Backup artifact exceeds size limit');
  const keys = Object.keys(artifact).sort().join(',');
  if (keys !== 'artifactHash,backupSchemaVersion,createdAt,payload,payloadHash,revision') {
    throw new Error('Backup artifact has unexpected fields');
  }
  if (artifact.backupSchemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error('Unsupported backup schema version');
  if (typeof artifact.createdAt !== 'string' || !Number.isFinite(Date.parse(artifact.createdAt))) throw new Error('Backup timestamp is invalid');
  if (new Date(artifact.createdAt).toISOString() !== artifact.createdAt) throw new Error('Backup timestamp is invalid');
  if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 0) throw new Error('Backup revision is invalid');
  if (!artifact.payload || artifact.payload.revision !== artifact.revision) throw new Error('Backup revision does not match payload');
  if (typeof artifact.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.payloadHash)) throw new Error('Backup payload hash is invalid');
  if (typeof artifact.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.artifactHash)) throw new Error('Backup artifact hash is invalid');

  const payload = asJsonSnapshot(artifact.payload);
  if (canonical(payload) !== canonical(artifact.payload)) throw new Error('Backup payload is not canonical V2 JSON');
  const actualPayloadHash = sha256(canonical(payload));
  if (actualPayloadHash !== artifact.payloadHash) throw new Error('Backup payload hash mismatch');
  if (sha256(metadataHashInput(artifact)) !== artifact.artifactHash) throw new Error('Backup metadata hash mismatch');

  return {
    valid: true,
    backupSchemaVersion: artifact.backupSchemaVersion,
    createdAt: artifact.createdAt,
    revision: artifact.revision,
    payloadHash: actualPayloadHash,
    artifactHash: artifact.artifactHash,
    counts: countsSummary(payload),
    inventory: inventorySummary(payload)
  };
}

export function serializeBackupArtifact(artifact) {
  verifyBackupArtifact(artifact);
  const serialized = JSON.stringify(artifact, null, 2) + '\n';
  if (encodedSize(serialized) > MAX_BACKUP_ARTIFACT_BYTES) throw new Error('Backup artifact exceeds size limit');
  return serialized;
}

export function parseBackupArtifact(source) {
  const raw = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
  if (raw.length > MAX_BACKUP_ARTIFACT_BYTES) throw new Error('Backup artifact exceeds size limit');
  let artifact;
  try {
    artifact = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Backup artifact is not valid JSON');
  }
  return { artifact, verification: verifyBackupArtifact(artifact) };
}

export function previewBackupRestore(artifact, currentSnapshot, { expectedCurrentRevision } = {}) {
  const backup = verifyBackupArtifact(artifact);
  const current = asJsonSnapshot(currentSnapshot);
  if (!Number.isSafeInteger(expectedCurrentRevision) || expectedCurrentRevision < 0) {
    throw new Error('Expected current revision is required');
  }
  if (current.revision !== expectedCurrentRevision) throw new Error('Current revision changed; refresh restore preview');
  return {
    status: 'manual-review-required',
    automaticApply: false,
    backup: {
      createdAt: backup.createdAt,
      revision: backup.revision,
      payloadHash: backup.payloadHash,
      counts: backup.counts,
      inventory: backup.inventory
    },
    current: {
      revision: current.revision,
      counts: countsSummary(current),
      inventory: inventorySummary(current)
    }
  };
}
