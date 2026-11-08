import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreBackupIdRegistry } from '../src/firestore-backup-id-registry.js';

function fakeFirestore() {
  const rows = new Map();
  const mutex = { tail: Promise.resolve() };
  const doc = (path) => ({
    path,
    async get() { const row = rows.get(path); return { exists: Boolean(row), data: () => structuredClone(row) }; }
  });
  return {
    rows,
    doc,
    async runTransaction(callback) {
      let release;
      const previous = mutex.tail;
      mutex.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        const pending = [];
        const transaction = {
          async get(ref) { const row = rows.get(ref.path); return { exists: Boolean(row), data: () => structuredClone(row) }; },
          create(ref, value) { pending.push([ref.path, structuredClone(value)]); }
        };
        const result = await callback(transaction);
        for (const [path, value] of pending) {
          if (rows.has(path)) throw new Error('already exists');
          rows.set(path, value);
        }
        return result;
      } finally { release(); }
    }
  };
}

const key = `v2/2026-11-08/revision-12-${'b'.repeat(64)}.json`;

test('Firestore backup ID registry is create-once, concurrent-safe, and stores only a hash of the key', async () => {
  const db = fakeFirestore();
  const registry = createFirestoreBackupIdRegistry(db, 'test/backupIds/keys', () => 123);
  const ids = await Promise.all([
    registry.getOrCreate(key, 'candidate-drive-id-1'),
    registry.getOrCreate(key, 'candidate-drive-id-2')
  ]);
  assert.equal(ids[0], ids[1]);
  assert.equal(await registry.get(key), ids[0]);
  const stored = JSON.stringify([...db.rows.values()]);
  assert.equal(stored.includes(key), false);
  assert.equal([...db.rows.values()][0].createdAtMs, 123);
});

test('Firestore backup ID registry validates keys, IDs, and stored schema', async () => {
  const db = fakeFirestore();
  const registry = createFirestoreBackupIdRegistry(db, 'test/backupIds/keys');
  await assert.rejects(registry.getOrCreate('not-a-backup-key', 'candidate-drive-id-1'), /backup key/);
  await assert.rejects(registry.getOrCreate(key, 'bad'), /file ID/);
});
