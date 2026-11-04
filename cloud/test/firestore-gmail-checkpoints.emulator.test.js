import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreGmailCheckpointStore } from '../src/firestore-gmail-checkpoints.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulatorHost ? false : 'Set FIRESTORE_EMULATOR_HOST to run Firestore Emulator integration tests';

test('Firestore Emulator fences concurrent and stale Gmail checkpoint generations', {
  skip: skipReason
}, async () => {
  const { Firestore } = await import('@google-cloud/firestore');
  const projectId = process.env.GCLOUD_PROJECT || 'demo-toreca-vault';
  const db = new Firestore({ projectId });
  const collectionPath = `gmailCheckpointTestRuns/${randomUUID()}/scans`;
  const store = createFirestoreGmailCheckpointStore(db, collectionPath);
  const untilMs = Date.now();
  const firstCursor = {
    sinceMs: untilMs - 60_000,
    untilMs,
    scanType: 'hourly',
    pageToken: null
  };

  try {
    await store.saveCursor('hourly', firstCursor, {
      expectedCursor: null,
      expectedLastSuccessfulAtMs: null
    });

    const candidates = [
      { ...firstCursor, pageToken: 'winner-a' },
      { ...firstCursor, pageToken: 'winner-b' }
    ];
    const outcomes = await Promise.allSettled(candidates.map((cursor) => store.saveCursor(
      'hourly',
      cursor,
      { expectedCursor: firstCursor, expectedLastSuccessfulAtMs: null }
    )));
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
    assert.equal(outcomes.find((item) => item.status === 'rejected').reason.name, 'GmailCheckpointConflict');

    const winner = (await store.load('hourly')).cursor;
    await store.completeScan('hourly', untilMs, {
      expectedCursor: winner,
      expectedLastSuccessfulAtMs: null
    });
    await assert.rejects(
      store.saveCursor('hourly', firstCursor, {
        expectedCursor: null,
        expectedLastSuccessfulAtMs: null
      }),
      { name: 'GmailCheckpointConflict' }
    );
    assert.deepEqual(await store.load('hourly'), {
      cursor: null,
      lastSuccessfulAtMs: untilMs
    });
  } finally {
    await db.doc(`${collectionPath}/hourly`).delete();
    await db.terminate();
  }
});
