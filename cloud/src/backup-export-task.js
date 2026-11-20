import {
  createBackupArtifact, parseBackupArtifact, serializeBackupArtifact
} from './backup-artifact.js';

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new Error('Backup repository returned an invalid object');
}

export function createBackupExportTask({ store, repository, clock = () => new Date() } = {}) {
  if (!store || typeof store.read !== 'function') throw new TypeError('a read-only canonical snapshot store is required');
  if (!repository || typeof repository.putIfAbsent !== 'function' || typeof repository.get !== 'function') {
    throw new TypeError('a create-once backup repository is required');
  }

  return async function exportBackup() {
    const current = await store.read();
    if (!current?.payload) throw new Error('Canonical snapshot is not initialized');
    if (current.revision !== current.payload.revision) throw new Error('Canonical revision does not match snapshot');

    const createdAt = clock();
    const artifact = createBackupArtifact(current.payload, { createdAt });
    const day = artifact.createdAt.slice(0, 10);
    const key = `v2/${day}/revision-${artifact.revision}-${artifact.payloadHash}.json`;
    const serialized = serializeBackupArtifact(artifact);
    const write = await repository.putIfAbsent(key, serialized);
    if (!write || typeof write.created !== 'boolean') throw new Error('Backup repository returned an invalid write result');

    const readback = parseBackupArtifact(asBuffer(await repository.get(key)));
    if (readback.verification.payloadHash !== artifact.payloadHash
      || readback.verification.revision !== artifact.revision) {
      throw new Error('Backup readback does not match the source snapshot');
    }
    return {
      created: write.created,
      key,
      createdAt: readback.verification.createdAt,
      revision: readback.verification.revision,
      payloadHash: readback.verification.payloadHash,
      artifactHash: readback.verification.artifactHash,
      counts: readback.verification.counts,
      inventory: readback.verification.inventory
    };
  };
}
