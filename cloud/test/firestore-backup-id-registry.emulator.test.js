import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreBackupIdRegistry } from '../src/firestore-backup-id-registry.js';

test('Firestore Emulator reserves one Drive file ID for concurrent retries of a backup key', async (t) => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) return t.skip('FIRESTORE_EMULATOR_HOST is not configured');
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: 'demo-toreca-vault' });
  const collectionPath = `torecaVaultV2/backupIdTest_${randomUUID().replaceAll('-', '')}/keys`;
  const registry = createFirestoreBackupIdRegistry(db, collectionPath);
  const key = `v2/2026-11-08/revision-12-${'c'.repeat(64)}.json`;
  const ref = db.collection(collectionPath);
  t.after(async () => {
    const snapshot = await ref.get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    await db.terminate();
  });

  const ids = await Promise.all([
    registry.getOrCreate(key, `synthetic-drive-id-${randomUUID()}`),
    registry.getOrCreate(key, `synthetic-drive-id-${randomUUID()}`)
  ]);
  assert.equal(ids[0], ids[1]);
  const stored = (await ref.get()).docs;
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored[0].data()).includes(key), false);
  assert.equal(await registry.get(key), ids[0]);
});
