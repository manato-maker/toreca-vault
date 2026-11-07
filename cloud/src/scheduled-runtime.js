import { getDueJobs } from './schedule.js';
import { dispatchJobs } from './worker-dispatcher.js';

const LEDGER_COMPLETION_JOBS = new Set(['lottery-result-focus', 'market-refresh']);
const FAILURE_STATUSES = new Set(['retry', 'dead', 'exhausted', 'lease-lost', 'unconfigured']);

function dateValue(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date or timestamp`);
  return date;
}

/** Parse Cloud Scheduler's RFC3339 X-CloudScheduler-ScheduleTime header. */
export function parseSchedulerScheduleTime(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('schedule time header is required');
  return dateValue(value, 'schedule time header');
}

/** Plan, dispatch independently, and record one bounded heartbeat for a Scheduler tick. */
export async function runScheduledTick({
  now = new Date(),
  scheduledAt = now,
  ledger,
  heartbeatStore,
  handlers,
  clock = () => Date.now(),
  leaseMs = 120_000,
  maxAttempts = 3
} = {}) {
  const actualTime = dateValue(now, 'now');
  const plannedTime = dateValue(scheduledAt, 'scheduledAt');
  if (!ledger || typeof ledger.inspect !== 'function'
    || typeof ledger.claim !== 'function'
    || typeof ledger.complete !== 'function'
    || typeof ledger.fail !== 'function') {
    throw new TypeError('a durable inspectable job ledger is required');
  }
  if (!heartbeatStore || typeof heartbeatStore.recordSuccess !== 'function') {
    throw new TypeError('a durable scheduler heartbeat store is required');
  }

  const completedJobKeys = new Set();
  const initialPlan = getDueJobs(actualTime, { scheduledAt: plannedTime });
  for (const job of initialPlan) {
    if (!LEDGER_COMPLETION_JOBS.has(job.kind)) continue;
    const existing = await ledger.inspect(job.jobKey);
    if (existing?.status === 'completed') completedJobKeys.add(job.jobKey);
  }
  const jobs = getDueJobs(actualTime, { scheduledAt: plannedTime, completedJobKeys });
  const results = [];
  for (const job of jobs) {
    const handler = handlers?.[job.kind];
    if (typeof handler !== 'function') {
      results.push({ jobKey: job.jobKey, status: 'unconfigured', errorCode: 'HandlerUnavailable' });
      continue;
    }
    const [result] = await dispatchJobs([job], {
      ledger,
      handlers: { [job.kind]: handler },
      clock,
      leaseMs,
      maxAttempts
    });
    results.push(result);
  }
  const failedJobCount = results.filter((result) => FAILURE_STATUSES.has(result.status)).length;
  const completedAtMs = clock();
  await heartbeatStore.recordSuccess({
    scheduledAtMs: plannedTime.getTime(),
    completedAtMs,
    failedJobCount
  });
  return {
    scheduledAt: plannedTime.toISOString(),
    triggeredAt: actualTime.toISOString(),
    plannedCount: jobs.length,
    failedJobCount,
    results
  };
}
