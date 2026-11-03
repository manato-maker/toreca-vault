import { applyChatCommand } from './v2-command.js';

/** Claim one durable request, apply a pure V2 transition, persist with CAS, then settle the lease. */
export async function processQueuedCommand({ queue, store, requestId, clock = () => Date.now(), leaseMs = 120_000, maxAttempts = 3 } = {}) {
  if (!queue || typeof queue.claim !== 'function' || typeof queue.finish !== 'function') throw new TypeError('a durable command queue is required');
  if (!store || typeof store.read !== 'function' || typeof store.save !== 'function') throw new TypeError('a V2 snapshot store is required');
  const claim = await queue.claim(requestId, { now: clock(), leaseMs, maxAttempts });
  if (!claim.claimed) return { status: claim.status, claimed: false };

  let outcome = 'pending';
  let resultCode = 'retryable-error';
  try {
    const current = await store.read();
    if (!current) {
      outcome = 'pending';
      resultCode = 'canonical-not-initialized';
    } else {
      const planned = applyChatCommand(current.payload, claim.command, { now: clock() });
      if (planned.duplicate) {
        outcome = 'done';
        resultCode = 'duplicate-already-applied';
      } else {
        const saved = await store.save({
          expectedRevision: current.revision,
          mutationId: planned.mutationId,
          payload: planned.state
        });
        if (saved.lastMutationId !== planned.mutationId || saved.revision !== planned.state.revision) {
          outcome = 'review';
          resultCode = 'readback-mismatch';
        } else {
          outcome = 'done';
          resultCode = 'v2-applied';
        }
      }
    }
  } catch (error) {
    if (error instanceof TypeError) {
      outcome = 'review';
      resultCode = 'command-invalid';
    } else if (error?.name === 'RevisionConflict') {
      outcome = 'pending';
      resultCode = 'revision-conflict';
    } else if (/not implemented|ambiguous|insufficient|not found|partial duplicate|already exists/i.test(String(error?.message || ''))) {
      outcome = 'review';
      resultCode = 'command-rejected';
    } else {
      outcome = 'pending';
      resultCode = 'retryable-error';
    }
  }
  const settled = await queue.finish(requestId, claim.claimToken, { outcome, resultCode, now: clock() });
  return { status: settled.status, outcome: settled.updated ? outcome : 'lease-lost', duplicate: resultCode === 'duplicate-already-applied', resultCode };
}
