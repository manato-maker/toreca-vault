import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandBatchWorker } from '../src/command-batch-worker.js';

test('command batch drains a bounded queue page and leaves uninitialized canonical state pending', async () => {
  const claims = [];
  const queue = {
    async listPending({ limit }) { assert.equal(limit, 2); return [{ requestId: 'r1' }, { requestId: 'r2' }]; },
    async claim(requestId) { claims.push(requestId); return { claimed: true, claimToken: `lease-${requestId}`, command: { requestId, type: 'purchase' } }; },
    async finish(requestId, claimToken, input) { return { status: input.outcome, updated: claimToken === `lease-${requestId}` }; }
  };
  const worker = createCommandBatchWorker({
    queue,
    store: { async read() { return null; }, async save() { throw new Error('must not write without canonical state'); } },
    batchSize: 2,
    clock: () => 100
  });
  const result = await worker({ scheduledAt: '2026-11-08T01:00:00Z' });
  assert.deepEqual(result, { processedCount: 2, done: 0, pending: 2, review: 0, busy: 0, missing: 0 });
  assert.deepEqual(claims, ['r1', 'r2']);
});

test('command batch validates the planned time and maximum page size', async () => {
  const dependencies = {
    queue: { listPending() {}, claim() {}, finish() {} },
    store: { read() {}, save() {} }
  };
  assert.throws(() => createCommandBatchWorker({ ...dependencies, batchSize: 51 }), /batchSize/);
  const worker = createCommandBatchWorker(dependencies);
  await assert.rejects(worker({ scheduledAt: 'not-a-time' }), /scheduledAt/);
});
