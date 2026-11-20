import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreJobLedger } from '../src/job-ledger.js';
import { createFirestoreSchedulerHeartbeatStore, evaluateSchedulerHealth } from '../src/scheduler-heartbeat.js';
import { parseSchedulerScheduleTime, runScheduledTick } from '../src/scheduled-runtime.js';

function fakeFirestore() {
  const docs = new Map();
  return {
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

const atJst = (time) => new Date(`2026-11-06T${time}:00+09:00`);

test('parses RFC3339 Cloud Scheduler planned time and rejects missing or malformed headers', () => {
  assert.equal(parseSchedulerScheduleTime('2026-11-06T09:00:00+09:00').toISOString(), '2026-11-06T00:00:00.000Z');
  assert.throws(() => parseSchedulerScheduleTime(''), /required/);
  assert.throws(() => parseSchedulerScheduleTime('not-a-date'), /valid date/);
});

test('dispatches the planned slot and suppresses completed daily focus using the durable ledger', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(db);
  const seen = [];
  const handlers = {
    'command-queue': async (job) => seen.push(job.jobKey),
    'lottery-result-focus': async (job) => seen.push(job.jobKey),
    'canonical-backup': async (job) => seen.push(job.jobKey)
  };
  const firstNow = atJst('12:30');
  const first = await runScheduledTick({
    now: firstNow, scheduledAt: firstNow, ledger, heartbeatStore, handlers,
    clock: () => firstNow.getTime() + 1000
  });
  assert.equal(first.plannedCount, 3);
  assert.equal(first.failedJobCount, 0);
  assert.equal(seen.length, 3);

  const nextNow = atJst('12:45');
  const next = await runScheduledTick({
    now: nextNow, scheduledAt: nextNow, ledger, heartbeatStore, handlers,
    clock: () => nextNow.getTime() + 1000
  });
  assert.equal(next.plannedCount, 1);
  assert.equal(next.results[0].status, 'completed');
  assert.equal(seen.length, 4);
  const heartbeat = await heartbeatStore.read();
  assert.equal(heartbeat.lastScheduledAtMs, nextNow.getTime());
  assert.equal(heartbeat.latestMissedSlots, 0);
});

test('records partial handler failures and missed slots in the heartbeat', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(db);
  const seven = atJst('07:00');
  const first = await runScheduledTick({
    now: seven, scheduledAt: seven, ledger, heartbeatStore,
    handlers: {
      'command-queue': async () => {},
      'gmail-lottery-inbox': async () => { throw Object.assign(new Error('private body'), { name: 'GmailQuotaError' }); },
      'canonical-backup': async () => {}
    },
    clock: () => seven.getTime() + 1000
  });
  assert.equal(first.failedJobCount, 1);
  const failed = await heartbeatStore.read();
  assert.equal(failed.failedJobCount, 1);
  assert.equal(JSON.stringify(failed).includes('private body'), false);
  assert.equal(evaluateSchedulerHealth(failed, { nowMs: seven.getTime() + 2000 }).healthy, false);

  const sevenThirty = atJst('07:30');
  const second = await runScheduledTick({
    now: sevenThirty, scheduledAt: sevenThirty, ledger, heartbeatStore,
    handlers: { 'command-queue': async () => {}, 'gmail-lottery-inbox': async () => {}, 'canonical-backup': async () => {} },
    clock: () => sevenThirty.getTime() + 1000
  });
  assert.equal(second.failedJobCount, 0);
  const recoveredTick = await heartbeatStore.read();
  assert.equal(recoveredTick.latestMissedSlots, 1);
  assert.equal(recoveredTick.totalMissedSlots, 1);
  assert.equal(recoveredTick.failedJobCount, 0);
  assert.equal(evaluateSchedulerHealth(recoveredTick, { nowMs: sevenThirty.getTime() + 2000 }).healthy, false);
});

test('an unconfigured job is recorded without blocking configured work or heartbeat', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(db);
  const seven = atJst('07:00');
  let queueRuns = 0;
  const tick = await runScheduledTick({
    now: seven,
    scheduledAt: seven,
    ledger,
    heartbeatStore,
    handlers: { 'command-queue': async () => { queueRuns += 1; }, 'canonical-backup': async () => {} },
    clock: () => seven.getTime() + 1000
  });

  assert.equal(queueRuns, 1);
  assert.equal(tick.plannedCount, 3);
  assert.equal(tick.failedJobCount, 1);
  assert.deepEqual(tick.results.map(({ status }) => status), ['completed', 'unconfigured', 'completed']);
  assert.equal(tick.results[1].errorCode, 'HandlerUnavailable');
  const heartbeat = await heartbeatStore.read();
  assert.equal(heartbeat.failedJobCount, 1);
  assert.equal(evaluateSchedulerHealth(heartbeat, { nowMs: seven.getTime() + 2000 }).healthy, false);
});

test('a failed Gmail job does not block the command queue or market refresh', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(db);
  const fourteen = atJst('14:00');
  const completed = [];
  const tick = await runScheduledTick({
    now: fourteen,
    scheduledAt: fourteen,
    ledger,
    heartbeatStore,
    handlers: {
      'command-queue': async () => { completed.push('command-queue'); },
      'gmail-lottery-inbox': async () => { throw Object.assign(new Error('temporary quota issue'), { name: 'GmailQuotaError' }); },
      'lottery-result-focus': async () => { completed.push('lottery-result-focus'); },
      'market-refresh': async () => { completed.push('market-refresh'); },
      'canonical-backup': async () => { completed.push('canonical-backup'); }
    },
    clock: () => fourteen.getTime() + 1000
  });

  assert.deepEqual(completed, ['command-queue', 'lottery-result-focus', 'market-refresh', 'canonical-backup']);
  assert.deepEqual(tick.results.map(({ status }) => status), ['completed', 'retry', 'completed', 'completed', 'completed']);
  assert.equal(tick.failedJobCount, 1);
  const heartbeat = await heartbeatStore.read();
  assert.equal(heartbeat.failedJobCount, 1);
});

test('daily backup catches up and the durable ledger suppresses repeats after success', async () => {
  const db = fakeFirestore();
  const ledger = createFirestoreJobLedger(db);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(db);
  const firstAt = new Date('2026-11-06T02:15:00+09:00');
  let backupRuns = 0;
  const handlers = {
    'command-queue': async () => {},
    'canonical-backup': async (job) => {
      backupRuns++;
      assert.equal(job.jobKey, 'canonical-backup:2026-11-06');
      assert.equal(job.scheduledAt, '2026-11-06T02:00+09:00');
    }
  };
  await runScheduledTick({
    now: firstAt, scheduledAt: firstAt, ledger, heartbeatStore, handlers,
    clock: () => firstAt.getTime() + 1000
  });
  const secondAt = new Date('2026-11-06T02:30:00+09:00');
  const second = await runScheduledTick({
    now: secondAt, scheduledAt: secondAt, ledger, heartbeatStore, handlers,
    clock: () => secondAt.getTime() + 1000
  });
  assert.equal(backupRuns, 1);
  assert.equal(second.results.some((result) => result.jobKey === 'canonical-backup:2026-11-06'), false);
});

