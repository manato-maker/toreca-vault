import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createGcsBackupRepository } from '../src/gcs-backup-repository.js';

const key = `v2/2026-11-08/revision-12-${'a'.repeat(64)}.json`;

function fakeBucket() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    file(name) {
      return {
        async save(content, options) {
          calls.push({ method: 'save', name, options });
          if (objects.has(name)) {
            const error = new Error('precondition failed');
            error.code = 412;
            throw error;
          }
          objects.set(name, Buffer.from(content));
        },
        async download() {
          calls.push({ method: 'download', name });
          if (!objects.has(name)) throw new Error('not found');
          return [Buffer.from(objects.get(name))];
        }
      };
    }
  };
}

test('GCS backup repository creates once with generation precondition and verifies bytes by readback', async () => {
  const bucket = fakeBucket();
  const repository = createGcsBackupRepository(bucket);
  const payload = JSON.stringify({ revision: 12, marker: 'synthetic' });
  assert.deepEqual(await repository.putIfAbsent(key, payload), { created: true });
  assert.deepEqual(await repository.putIfAbsent(key, 'must-not-overwrite'), { created: false });
  assert.deepEqual(await repository.get(key), Buffer.from(payload));

  const save = bucket.calls.find((call) => call.method === 'save');
  assert.equal(save.options.preconditionOpts.ifGenerationMatch, 0);
  assert.equal(save.options.resumable, false);
  assert.equal(save.options.metadata.metadata.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.equal(bucket.objects.get(key).toString('utf8'), payload);
});

test('GCS repository rejects unsafe keys and oversized or empty artifacts before upload', async () => {
  const bucket = fakeBucket();
  const repository = createGcsBackupRepository(bucket);
  await assert.rejects(repository.putIfAbsent('../escape', '{}'), /key is invalid/);
  await assert.rejects(repository.get('../escape'), /key is invalid/);
  await assert.rejects(repository.putIfAbsent(key, ''), /size/);
  await assert.rejects(repository.putIfAbsent(key, Buffer.alloc(7_500_001)), /size/);
  assert.equal(bucket.calls.length, 0);
});

test('90-day lifecycle proposal deletes only objects under v2/', async () => {
  const policy = JSON.parse(await readFile(new URL('../backup-lifecycle-proposed.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy.lifecycle.rule, [{
    action: { type: 'Delete' },
    condition: { age: 90, matchesPrefix: ['v2/'] }
  }]);
});
