const DEFAULT_DOCUMENT = 'torecaVaultV2/schedulerHeartbeat/dispatchers/current';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer timestamp`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function safeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

/** Return safe, bounded health metadata for the most recent dispatcher tick. */
export function evaluateSchedulerHealth(heartbeat, {
  nowMs = Date.now(),
  staleAfterMs = 3 * DEFAULT_INTERVAL_MS
} = {}) {
  const now = timestamp(nowMs, 'nowMs');
  const staleAfter = positiveInteger(staleAfterMs, 'staleAfterMs');
  if (!heartbeat) return {
    healthy: false,
    stale: true,
    lastScheduledAtMs: null,
    lastCompletedAtMs: null,
    ageMs: null,
    latestMissedSlots: 0,
    failedJobCount: 0
  };
  const lastScheduledAtMs = timestamp(heartbeat.lastScheduledAtMs, 'heartbeat.lastScheduledAtMs');
  const lastCompletedAtMs = timestamp(heartbeat.lastCompletedAtMs, 'heartbeat.lastCompletedAtMs');
  const latestMissedSlots = safeCount(heartbeat.latestMissedSlots ?? 0, 'heartbeat.latestMissedSlots');
  const failedJobCount = safeCount(heartbeat.failedJobCount ?? 0, 'heartbeat.failedJobCount');
  const ageMs = Math.max(0, now - lastCompletedAtMs);
  const stale = ageMs > staleAfter;
  return {
    healthy: !stale && latestMissedSlots === 0 && failedJobCount === 0,
    stale,
    lastScheduledAtMs,
    lastCompletedAtMs,
    ageMs,
    latestMissedSlots,
    failedJobCount
  };
}

/** Persist bounded scheduler liveness data; this store never contains job payloads or error text. */
export function createFirestoreSchedulerHeartbeatStore(db, documentPath = DEFAULT_DOCUMENT, {
  intervalMs = DEFAULT_INTERVAL_MS
} = {}) {
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('a Firestore client is required');
  }
  if (typeof documentPath !== 'string' || !documentPath.trim()) throw new TypeError('documentPath is required');
  const interval = positiveInteger(intervalMs, 'intervalMs');
  const ref = db.doc(documentPath);

  return {
    async recordSuccess({ scheduledAtMs, completedAtMs = Date.now(), failedJobCount = 0 } = {}) {
      const scheduled = timestamp(scheduledAtMs, 'scheduledAtMs');
      const completed = timestamp(completedAtMs, 'completedAtMs');
      const failures = safeCount(failedJobCount, 'failedJobCount');
      if (completed < scheduled) throw new TypeError('completedAtMs must not precede scheduledAtMs');
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? snapshot.data() : null;
        if (current) {
          if (current.schemaVersion !== 1) throw new Error('scheduler heartbeat schema version is unsupported');
          timestamp(current.lastScheduledAtMs, 'heartbeat.lastScheduledAtMs');
          timestamp(current.lastCompletedAtMs, 'heartbeat.lastCompletedAtMs');
          safeCount(current.latestMissedSlots, 'heartbeat.latestMissedSlots');
          safeCount(current.totalMissedSlots, 'heartbeat.totalMissedSlots');
          safeCount(current.failedJobCount, 'heartbeat.failedJobCount');
        }
        const priorScheduled = current?.lastScheduledAtMs ?? null;
        if (priorScheduled != null && scheduled === priorScheduled) {
          const priorCompleted = timestamp(current.lastCompletedAtMs, 'heartbeat.lastCompletedAtMs');
          if (completed <= priorCompleted) return { recorded: false, duplicate: true, stale: false };
          transaction.set(ref, {
            ...current,
            lastCompletedAtMs: completed,
            failedJobCount: failures,
            updatedAtMs: completed
          });
          return { recorded: true, duplicate: true, stale: false, refreshed: true };
        }
        if (priorScheduled != null && scheduled < priorScheduled) {
          return { recorded: false, duplicate: false, stale: true };
        }
        const gap = priorScheduled == null ? 0 : Math.max(0, Math.floor((scheduled - priorScheduled) / interval) - 1);
        const next = {
          schemaVersion: 1,
          lastScheduledAtMs: scheduled,
          lastCompletedAtMs: completed,
          latestMissedSlots: gap,
          totalMissedSlots: safeCount(current?.totalMissedSlots ?? 0, 'heartbeat.totalMissedSlots') + gap,
          failedJobCount: failures,
          updatedAtMs: completed
        };
        transaction.set(ref, next);
        return { recorded: true, duplicate: false, stale: false, latestMissedSlots: gap };
      });
    },

    async read() {
      const snapshot = await ref.get();
      if (!snapshot.exists) return null;
      const data = snapshot.data();
      if (data.schemaVersion !== 1) throw new Error('scheduler heartbeat schema version is unsupported');
      // Validate before exposing values to health reporting.
      timestamp(data.lastScheduledAtMs, 'heartbeat.lastScheduledAtMs');
      timestamp(data.lastCompletedAtMs, 'heartbeat.lastCompletedAtMs');
      safeCount(data.latestMissedSlots, 'heartbeat.latestMissedSlots');
      safeCount(data.totalMissedSlots, 'heartbeat.totalMissedSlots');
      safeCount(data.failedJobCount, 'heartbeat.failedJobCount');
      return data;
    }
  };
}
