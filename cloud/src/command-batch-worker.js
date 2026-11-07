import { processQueuedCommand } from './command-worker.js';

/** Drain a bounded batch of pending requests; queue leases fence concurrent Cloud Run instances. */
export function createCommandBatchWorker({ queue, store, batchSize = 10, clock = () => Date.now() } = {}) {
  if (!queue || typeof queue.listPending !== 'function') throw new TypeError('a queryable durable command queue is required');
  if (!queue || typeof queue.claim !== 'function' || typeof queue.finish !== 'function') throw new TypeError('a claimable durable command queue is required');
  if (!store || typeof store.read !== 'function' || typeof store.save !== 'function') throw new TypeError('a canonical V2 store is required');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new RangeError('batchSize must be from 1 to 50');

  return async function drainPendingCommands({ scheduledAt } = {}) {
    const plannedTime = scheduledAt instanceof Date ? scheduledAt.getTime() : Date.parse(String(scheduledAt || ''));
    if (!Number.isSafeInteger(plannedTime) || plannedTime < 0) throw new TypeError('scheduledAt must be valid');
    const pending = await queue.listPending({ limit: batchSize });
    if (!Array.isArray(pending) || pending.length > batchSize) throw new Error('command queue returned an invalid batch');
    const results = [];
    for (const item of pending) {
      if (!item || typeof item.requestId !== 'string' || !item.requestId.trim()) throw new Error('command queue returned an invalid request ID');
      const result = await processQueuedCommand({ queue, store, requestId: item.requestId, clock });
      results.push(result.status);
    }
    const counts = Object.fromEntries(['done', 'pending', 'review', 'busy', 'missing'].map((status) => [status, results.filter((value) => value === status).length]));
    return { processedCount: results.length, ...counts };
  };
}
