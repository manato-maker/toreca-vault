import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreSchedulerHeartbeatStore, evaluateSchedulerHealth } from '../src/scheduler-heartbeat.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    seed(path, value) { docs.set(path, structuredClone(value)); },
    doc(path) {
      return {
        path,
        async get() {
          const value = docs.get(path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        }
      };
    },
    async runTransaction(callback) {
      const writes = new Map();
      const transaction = {
        async get(ref) {
          const value = writes.has(ref.path) ? writes.get(ref.path) : docs.get(ref.path);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
        set(ref, value) { writes.set(ref.path, structuredClone(value)); }
      };
      const result = await callback(transaction);
      for (const [path, value] of writes) docs.set(path, value);
      return result;
    }
  };
}

const quarterHour = 15 * 60 * 1000;

test('records one bounded heartbeat and treats scheduler retries as idempotent', async () => {
  const store = createFirestoreSchedulerHeartbeatStore(fakeFirestore());
  assert.deepEqual(await store.recordSuccess({ scheduledAtMs: quarterHour, completedAtMs: quarterHour + 2000 }), {
    recorded: true, duplicate: false, stale: false, latestMissedSlots: 0
  });
  assert.deepEqual(await store.recordSuccess({ scheduledAtMs: quarterHour, completedAtMs: quarterHour + 3000 }), {
    recorded: true, duplicate: true, stale: false, refreshed: true
  });
  assert.deepEqual(await store.read(), {
    schemaVersion: 1,
    lastScheduledAtMs: quarterHour,
    lastCompletedAtMs: quarterHour + 3000,
    latestMissedSlots: 0,
    totalMissedSlots: 0,
    failedJobCount: 0,
    updatedAtMs: quarterHour + 3000
  });
});

test('counts skipped quarter-hour slots without replaying old scheduled runs', async () => {
  const store = createFirestoreSchedulerHeartbeatStore(fakeFirestore());
  await store.recordSuccess({ scheduledAtMs: quarterHour, completedAtMs: quarterHour + 1000 });
  assert.deepEqual(await store.recordSuccess({ scheduledAtMs: quarterHour * 4, completedAtMs: quarterHour * 4 + 1000, failedJobCount: 1 }), {
    recorded: true, duplicate: false, stale: false, latestMissedSlots: 2
  });
  assert.deepEqual(await store.recordSuccess({ scheduledAtMs: quarterHour * 2, completedAtMs: quarterHour * 4 + 2000 }), {
    recorded: false, duplicate: false, stale: true
  });
  const heartbeat = await store.read();
  assert.equal(heartbeat.lastScheduledAtMs, quarterHour * 4);
  assert.equal(heartbeat.latestMissedSlots, 2);
  assert.equal(heartbeat.totalMissedSlots, 2);
  assert.equal(heartbeat.failedJobCount, 1);
  assert.equal(JSON.stringify(heartbeat).includes('Error:'), false);
});

test('health evaluation reports missing, stale, missed, and failed dispatcher state', () => {
  assert.deepEqual(evaluateSchedulerHealth(null, { nowMs: 10_000 }), {
    healthy: false, stale: true,
    lastScheduledAtMs: null, lastCompletedAtMs: null, ageMs: null,
    latestMissedSlots: 0, failedJobCount: 0
  });
  assert.deepEqual(evaluateSchedulerHealth({
    lastScheduledAtMs: 1_000, lastCompletedAtMs: 2_000, latestMissedSlots: 0, failedJobCount: 0
  }, { nowMs: 3_000, staleAfterMs: 5_000 }), {
    healthy: true, stale: false,
    lastScheduledAtMs: 1_000, lastCompletedAtMs: 2_000, ageMs: 1_000,
    latestMissedSlots: 0, failedJobCount: 0
  });
  const failed = evaluateSchedulerHealth({
    lastScheduledAtMs: 1_000, lastCompletedAtMs: 2_000, latestMissedSlots: 2, failedJobCount: 1
  }, { nowMs: 20_000, staleAfterMs: 5_000 });
  assert.equal(failed.healthy, false);
  assert.equal(failed.stale, true);
  assert.equal(failed.latestMissedSlots, 2);
  assert.equal(failed.failedJobCount, 1);
});

test('rejects malformed timestamps, counters, and unsupported stored heartbeat schemas', async () => {
  const db = fakeFirestore();
  const store = createFirestoreSchedulerHeartbeatStore(db);
  await assert.rejects(store.recordSuccess({ scheduledAtMs: -1, completedAtMs: 0 }), /scheduledAtMs/);
  await assert.rejects(store.recordSuccess({ scheduledAtMs: 10, completedAtMs: 9 }), /must not precede/);
  await assert.rejects(store.recordSuccess({ scheduledAtMs: 10, failedJobCount: -1 }), /failedJobCount/);
  assert.throws(() => createFirestoreSchedulerHeartbeatStore(fakeFirestore(), 'x/y', { intervalMs: 0 }), /intervalMs/);
  db.seed('torecaVaultV2/schedulerHeartbeat/dispatchers/current', { schemaVersion: 999 });
  await assert.rejects(store.read(), /schema version/);
});

