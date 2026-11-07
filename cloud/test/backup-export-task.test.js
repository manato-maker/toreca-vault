import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import { createBackupArtifact } from '../src/backup-artifact.js';
import { createBackupExportTask } from '../src/backup-export-task.js';
import { createFileBackupRepository } from '../src/file-backup-repository.js';

function snapshot() {
  return applyTransaction(emptyV2(), {
    id: 'backup-purchase', type: 'purchase', product: 'Private Product', productKey: 'private',
    category: 'BOX', condition: 'あり', quantity: 2, unitCost: 500, date: '2026-11-07'
  }, 'backup-mutation');
}

function memoryRepository() {
  const objects = new Map();
  let writes = 0;
  return {
    objects,
    get writes() { return writes; },
    async putIfAbsent(key, value) {
      if (objects.has(key)) return { created: false };
      objects.set(key, value);
      writes += 1;
      return { created: true, generation: String(writes) };
    },
    async get(key) { return objects.get(key); }
  };
}

test('backup export creates once, verifies storage readback, and returns only safe aggregates', async () => {
  const payload = snapshot();
  const before = JSON.stringify(payload);
  const repo = memoryRepository();
  let tick = 0;
  const task = createBackupExportTask({
    store: { async read() { return { payload, revision: payload.revision }; } },
    repository: repo,
    clock: () => new Date(Date.parse('2026-11-07T13:35:00.000Z') + (tick++ * 60_000))
  });

  const first = await task();
  const repeated = await task();
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.createdAt, first.createdAt);
  assert.equal(repo.writes, 1);
  assert.equal(first.key, `v2/2026-11-07/revision-1-${first.payloadHash}.json`);
  assert.equal(first.counts.transactions, 1);
  assert.equal(first.inventory.totalQuantity, 2);
  assert.equal(first.inventory.knownAcquisitionCost, 1000);
  assert.equal(JSON.stringify(first).includes('Private Product'), false);
  assert.equal(JSON.stringify(payload), before);
});

test('backup export fails closed on absent canonical data, mismatched revision, or corrupt readback', async () => {
  const repo = memoryRepository();
  const absent = createBackupExportTask({ store: { async read() { return null; } }, repository: repo });
  await assert.rejects(absent(), /not initialized/);

  const payload = snapshot();
  const stale = createBackupExportTask({
    store: { async read() { return { payload, revision: payload.revision + 1 }; } }, repository: repo
  });
  await assert.rejects(stale(), /does not match/);
  assert.equal(repo.writes, 0);

  const corruptedRepository = {
    async putIfAbsent() { return { created: true }; },
    async get() {
      const artifact = createBackupArtifact(payload, { createdAt: '2026-11-07T13:35:00.000Z' });
      artifact.payloadHash = '0'.repeat(64);
      return serializeBackupArtifactForTest(artifact);
    }
  };
  const corrupt = createBackupExportTask({
    store: { async read() { return { payload, revision: payload.revision }; } },
    repository: corruptedRepository,
    clock: () => new Date('2026-11-07T13:35:00.000Z')
  });
  await assert.rejects(corrupt(), /payload hash mismatch/);
});

test('local backup repository uses create-once private files and rejects unsafe keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toreca-repository-'));
  try {
    const repository = createFileBackupRepository(directory);
    const payload = snapshot();
    const task = createBackupExportTask({
      store: { async read() { return { payload, revision: payload.revision }; } },
      repository,
      clock: () => new Date('2026-11-07T13:35:00.000Z')
    });
    const first = await task();
    const again = await task();
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.payloadHash, first.payloadHash);
    const file = resolve(directory, first.key);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse((await repository.get(first.key)).toString('utf8')).payload, payload);
    await assert.rejects(repository.putIfAbsent('../../escape.json', '{}'), /key is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function serializeBackupArtifactForTest(artifact) {
  // Simulate a damaged object in the injected backing store without changing the source state.
  return JSON.stringify(artifact);
}
