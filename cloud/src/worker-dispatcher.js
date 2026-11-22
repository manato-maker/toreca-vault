function safeErrorCode(error) {
  const name = String(error?.name || 'WorkerError');
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? name : 'WorkerError';
}

/** Run planned jobs independently under durable leases; handlers must be idempotent. */
export async function dispatchJobs(jobs, {
  ledger,
  handlers,
  clock = () => Date.now(),
  leaseMs = 120_000,
  maxAttempts = 3
} = {}) {
  if (!ledger || typeof ledger.claim !== 'function' || typeof ledger.complete !== 'function' || typeof ledger.fail !== 'function') {
    throw new TypeError('a durable job ledger is required');
  }
  if (!handlers || typeof handlers !== 'object') throw new TypeError('job handlers are required');
  const seen = new Set();
  for (const job of jobs) {
    if (!job || typeof job.kind !== 'string' || typeof job.jobKey !== 'string' || !job.jobKey) {
      throw new TypeError('every planned job needs a kind and jobKey');
    }
    if (seen.has(job.jobKey)) throw new Error('planned job keys must be unique');
    seen.add(job.jobKey);
    if (typeof handlers[job.kind] !== 'function') throw new Error(`missing handler for ${job.kind}`);
  }

  const results = [];
  for (const job of jobs) {
    const claim = await ledger.claim(job.jobKey, { now: clock(), leaseMs, maxAttempts });
    if (!claim.claimed) {
      results.push({ jobKey: job.jobKey, status: claim.status });
      continue;
    }
    try {
      await handlers[job.kind](job);
      const completion = await ledger.complete(job.jobKey, claim.claimToken, { now: clock() });
      results.push({ jobKey: job.jobKey, status: completion.duplicate ? 'completed-duplicate' : 'completed' });
    } catch (error) {
      try {
        const failure = await ledger.fail(job.jobKey, claim.claimToken, error, { now: clock(), maxAttempts });
        results.push({ jobKey: job.jobKey, status: failure.status, errorCode: safeErrorCode(error) });
      } catch {
        // A late worker may lose its lease after another dispatcher reclaims it.
        results.push({ jobKey: job.jobKey, status: 'lease-lost', errorCode: safeErrorCode(error) });
      }
    }
  }
  return results;
}

