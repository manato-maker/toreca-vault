import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreGoogleSheetsIntakeCursorStore } from '../src/firestore-google-sheets-intake-cursor.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore intake cursor fences concurrent pages and resumes at the committed next row', { skip: skipReason }, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: process.env.GCLOUD_PROJECT || 'demo-toreca-vault' });
  const namespace = `sheetsIntakeCursorTestRuns/${randomUUID()}`;
  const parent = db.doc(namespace);
  const cursor = createFirestoreGoogleSheetsIntakeCursorStore(
    db,
    '1abcdefghijklmnopqrstuvwxyz0123456789',
    `${namespace}/cursors`
  );
  try {
    assert.deepEqual(await cursor.read(), { nextRow: 2, generation: 0 });
    const writes = await Promise.all([
      cursor.advance({ expectedNextRow: 2, nextRow: 22, now: 1234 }),
      cursor.advance({ expectedNextRow: 2, nextRow: 42, now: 1235 })
    ]);
    assert.equal(writes.filter(Boolean).length, 1);
    const current = await cursor.read();
    assert.ok([22, 42].includes(current.nextRow));
    assert.equal(current.generation, 1);
    assert.equal(await cursor.advance({ expectedNextRow: 2, nextRow: 62 }), false);
  } finally {
    await db.recursiveDelete(parent);
    await db.terminate();
  }
});
