import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreGoogleSheetsIntakeCursorStore } from '../src/firestore-google-sheets-intake-cursor.js';

const spreadsheetId = '1abcdefghijklmnopqrstuvwxyz0123456789';

function fakeFirestore() {
  const values = new Map();
  const ref = { path: '' };
  const db = {
    values,
    collection(name) {
      return { doc(id) { ref.path = `${name}/${id}`; return ref; } };
    },
    async runTransaction(callback) {
      const pending = [];
      const transaction = {
        async get(target) {
          const value = values.get(target.path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
        set(target, value) { pending.push([target.path, structuredClone(value)]); }
      };
      const result = await callback(transaction);
      for (const [path, value] of pending) values.set(path, value);
      return result;
    }
  };
  ref.get = async () => {
    const value = values.get(ref.path);
    return { exists: value !== undefined, data: () => structuredClone(value) };
  };
  return db;
}

test('Firestore cursor starts at row two, advances with compare-and-set, and stores no sheet content', async () => {
  const db = fakeFirestore();
  const cursor = createFirestoreGoogleSheetsIntakeCursorStore(db, spreadsheetId, 'testCursors');
  assert.deepEqual(await cursor.read(), { nextRow: 2, generation: 0 });
  assert.equal(await cursor.advance({ expectedNextRow: 2, nextRow: 22, now: 1234 }), true);
  assert.equal(await cursor.advance({ expectedNextRow: 2, nextRow: 42, now: 1235 }), false);
  assert.deepEqual(await cursor.read(), { nextRow: 22, generation: 1 });
  const stored = [...db.values.values()][0];
  assert.deepEqual(Object.keys(stored).sort(), ['generation', 'nextRow', 'schemaVersion', 'updatedAtMs']);
  assert.equal(JSON.stringify(stored).includes(spreadsheetId), false);
});

test('Firestore cursor rejects malformed stored state and unsafe advances', async () => {
  const db = fakeFirestore();
  const cursor = createFirestoreGoogleSheetsIntakeCursorStore(db, spreadsheetId, 'testCursors');
  await assert.rejects(cursor.advance({ expectedNextRow: 1, nextRow: 3 }), /expectedNextRow/);
  await assert.rejects(cursor.advance({ expectedNextRow: 2, nextRow: 2 }), /must advance/);
  assert.throws(() => createFirestoreGoogleSheetsIntakeCursorStore(db, 'short', 'testCursors'), /spreadsheetId/);
});
