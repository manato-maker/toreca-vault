import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../cloud/src/server.js';
import { createLotteryBusinessEventKey } from '../cloud/src/business-event-identity.js';
import { CanonicalNotInitialized, RevisionConflict } from '../cloud/src/firestore-store.js';
import { emptyV2 } from '../v2/core.js';

const TOKEN = 'test-secret-token-that-is-long-enough-0001';

function createFakeStore(initial = null) {
  let current = initial ? structuredClone(initial) : null;
  return {
    async read() { return current ? structuredClone(current) : null; },
    async save(input) {
      if (!current) {
        throw new CanonicalNotInitialized();
      }
      if (current.payload.auditLog.some((entry) => entry.mutationId === input.mutationId)) {
        return { ...structuredClone(current), duplicate: true };
      }
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflict(current.revision);
      }
      current = {
        payload: structuredClone(input.payload),
        revision: input.payload.revision,
        lastMutationId: input.mutationId,
        duplicate: false
      };
      return structuredClone(current);
    }
  };
}

async function withServer(store, run, options = {}) {
  const server = createServer({ store, apiToken: TOKEN, allowedOrigins: new Set(['https://example.test']), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function createFakeQueue() {
  const rows = new Map();
  return {
    async enqueue({ requestId, command }) {
      const prior = rows.get(requestId);
      if (prior) return prior.commandJson === JSON.stringify(command)
        ? { accepted: true, duplicate: true, status: prior.status }
        : { accepted: false, status: 'collision' };
      rows.set(requestId, {
        commandJson: JSON.stringify(command), status: 'pending',
        createdAtMs: 100, updatedAtMs: 100, resultCode: ''
      });
      return { accepted: true, duplicate: false, status: 'pending' };
    },
    async inspect(requestId) {
      const row = rows.get(requestId);
      return row ? structuredClone(row) : null;
    },
    setStatus(requestId, status, resultCode) {
      const row = rows.get(requestId);
      rows.set(requestId, { ...row, status, resultCode, updatedAtMs: 200 });
    }
  };
}

test('scheduler route is disabled by default and requires injected authorization', async () => {
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/scheduler/tick`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'scheduler route is disabled' });
  });

  let tickCalls = 0;
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/scheduler/tick`, {
      method: 'POST',
      headers: { 'x-cloudscheduler': 'true', 'x-cloudscheduler-scheduletime': '2026-11-06T09:00:00+09:00' }
    });
    assert.equal(response.status, 401);
    assert.equal(tickCalls, 0);
  }, {
    schedulerAuthorize: async (request) => request.headers['x-scheduler-auth'] === 'trusted',
    schedulerTick: async () => { tickCalls++; return { plannedCount: 1, failedJobCount: 0 }; }
  });
});

test('scheduler health endpoint exposes only bounded heartbeat state and marks unhealthy ticks with 503', async () => {
  const healthy = {
    healthy: true, stale: false, lastScheduledAtMs: 1_000, lastCompletedAtMs: 1_010,
    ageMs: 10, latestMissedSlots: 0, failedJobCount: 0, rawError: 'must not leak'
  };
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/health/scheduler`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, stale: false, lastScheduledAtMs: 1_000, lastCompletedAtMs: 1_010,
      ageMs: 10, latestMissedSlots: 0, failedJobCount: 0
    });
  }, { schedulerHealth: async () => healthy });

  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/health/scheduler`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false, stale: true, lastScheduledAtMs: null, lastCompletedAtMs: null,
      ageMs: null, latestMissedSlots: 0, failedJobCount: 0
    });
  }, { schedulerHealth: async () => null });

  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/health/scheduler`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.failedJobCount, 2);
  }, { schedulerHealth: async () => ({
    healthy: true, stale: false, lastScheduledAtMs: 1_000, lastCompletedAtMs: 1_010,
    ageMs: 10, latestMissedSlots: 0, failedJobCount: 2
  }) });

  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/health/scheduler`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'scheduler health unavailable' });
  }, { schedulerHealth: async () => { throw new Error('sensitive raw failure'); } });
});

test('scheduler route validates planned time, dispatches an authorized tick, and retries safe failures', async () => {
  const calls = [];
  await withServer(createFakeStore(), async (base) => {
    const request = (headers) => fetch(`${base}/internal/scheduler/tick`, { method: 'POST', headers });
    const common = { 'x-scheduler-auth': 'trusted', 'x-cloudscheduler': 'true' };
    const missingTime = await request(common);
    assert.equal(missingTime.status, 400);
    assert.equal((await missingTime.json()).error, 'invalid scheduler time');

    const missingMarker = await request({ ...common, 'x-cloudscheduler-scheduletime': '2026-11-06T09:00:00+09:00', 'x-cloudscheduler': 'false' });
    assert.equal(missingMarker.status, 400);
    assert.equal(calls.length, 0);

    const success = await request({ ...common, 'x-cloudscheduler-scheduletime': '2026-11-06T09:00:00+09:00' });
    assert.equal(success.status, 200);
    const body = await success.json();
    assert.deepEqual(body, {
      ok: true, scheduledAt: '2026-11-06T00:00:00.000Z', plannedCount: 2, failedJobCount: 0
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scheduledAt.toISOString(), '2026-11-06T00:00:00.000Z');
    assert.ok(calls[0].triggeredAt instanceof Date);

    const retry = await request({ ...common, 'x-cloudscheduler-scheduletime': '2026-11-06T09:15:00+09:00' });
    assert.equal(retry.status, 503);
    assert.deepEqual(await retry.json(), {
      ok: false, scheduledAt: '2026-11-06T00:15:00.000Z', plannedCount: 2, failedJobCount: 1
    });
  }, {
    schedulerAuthorize: async (request) => request.headers['x-scheduler-auth'] === 'trusted',
    schedulerTick: async (input) => {
      calls.push(input);
      return { plannedCount: 2, failedJobCount: calls.length === 2 ? 1 : 0, results: ['not exposed'] };
    }
  });
});

test('Google Sheets intake route is disabled by default and cannot accept work without the queue gate', async () => {
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/worker/sheets-intake`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'Google Sheets intake is disabled' });
  });

  let calls = 0;
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/worker/sheets-intake`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'Google Sheets intake is disabled' });
    assert.equal(calls, 0);
  }, {
    sheetsIntakeEnabled: true,
    sheetsIntakeAuthorize: async () => true,
    sheetsIntakeWorker: async () => { calls++; return { seen: 1 }; }
  });
});

test('Google Sheets intake route requires Scheduler authorization and returns bounded aggregate counts only', async () => {
  const calls = [];
  await withServer(createFakeStore(), async (base) => {
    const makeRequest = (headers = {}) => fetch(`${base}/internal/worker/sheets-intake`, { method: 'POST', headers });
    const unauthorized = await makeRequest({ 'x-cloudscheduler': 'true', 'x-cloudscheduler-scheduletime': '2026-11-08T12:00:00Z' });
    assert.equal(unauthorized.status, 401);

    const common = { 'x-intake-auth': 'trusted', 'x-cloudscheduler': 'true' };
    const missingTime = await makeRequest(common);
    assert.equal(missingTime.status, 400);
    const wrongMarker = await makeRequest({ ...common, 'x-cloudscheduler': 'false', 'x-cloudscheduler-scheduletime': '2026-11-08T12:00:00Z' });
    assert.equal(wrongMarker.status, 400);

    const response = await makeRequest({ ...common, 'x-cloudscheduler-scheduletime': '2026-11-08T12:00:00Z' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, scheduledAt: '2026-11-08T12:00:00.000Z', seen: 2,
      enqueued: 1, duplicate: 1, review: 0, skipped: 0
    });
    assert.equal(calls.length, 1);
  }, {
    commandsEnabled: true,
    sheetsIntakeEnabled: true,
    sheetsIntakeAuthorize: async (request) => request.headers['x-intake-auth'] === 'trusted',
    sheetsIntakeWorker: async (input) => {
      calls.push(input);
      return { seen: 2, enqueued: 1, duplicate: 1, review: 0, skipped: 0, rawRows: ['must not leak'] };
    }
  });
  assert.equal(calls[0].scheduledAt.toISOString(), '2026-11-08T12:00:00.000Z');
});

test('command worker route is disabled by default and requires authorization plus the planned Scheduler slot', async () => {
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/worker/commands`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'command worker is disabled' });
  });

  let disabledCalls = 0;
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/internal/worker/commands`, { method: 'POST', headers: { 'x-cloudscheduler': 'true', 'x-cloudscheduler-scheduletime': '2026-11-08T10:15:00+09:00' } });
    assert.equal(response.status, 503);
    assert.equal(disabledCalls, 0);
  }, {
    commandWorker: async () => { disabledCalls++; return { processedCount: 1 }; },
    workerAuthorize: async () => true
  });

  let calls = 0;
  await withServer(createFakeStore(), async (base) => {
    const headers = { 'x-cloudscheduler': 'true', 'x-cloudscheduler-scheduletime': '2026-11-08T10:15:00+09:00' };
    const denied = await fetch(`${base}/internal/worker/commands`, { method: 'POST', headers });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/internal/worker/commands`, { method: 'POST', headers: { ...headers, 'x-worker-auth': 'trusted' } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), {
      ok: true, scheduledAt: '2026-11-08T01:15:00.000Z', processedCount: 2,
      doneCount: 1, pendingCount: 1, reviewCount: 0, busyCount: 0
    });
    assert.equal(calls, 1);
  }, {
    writesEnabled: true,
    commandsEnabled: true,
    workerAuthorize: async (request) => request.headers['x-worker-auth'] === 'trusted',
    commandWorker: async (input) => {
      calls++;
      assert.equal(input.scheduledAt.toISOString(), '2026-11-08T01:15:00.000Z');
      return { processedCount: 2, done: 1, pending: 1, review: 0, busy: 0, secret: 'never returned' };
    }
  });
});

test('health is read-only and reports an uninitialized canonical store', async () => {
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, service: 'toreca-vault-v2-api', canonicalInitialized: false, writesEnabled: false
    });
  });
});

test('writes are disabled by default and rejected before reaching the store', async () => {
  const store = createFakeStore({ payload: emptyV2(), revision: 0, lastMutationId: '' });
  let writes = 0;
  const originalSave = store.save;
  store.save = async (...args) => { writes++; return originalSave(...args); };
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/v2`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, mutationId: 'm1', payload: emptyV2() })
    });
    assert.equal(response.status, 423);
    assert.deepEqual(await response.json(), { ok: false, error: 'writes are disabled until migration acceptance' });
    assert.equal(writes, 0);
  });
});

test('command queue is disabled by default and requires bearer auth when enabled', async () => {
  const store = createFakeStore();
  const body = { action: 'enqueueCommand', requestId: 'purchase-1', command: { requestId: 'purchase-1', type: 'purchase' } };
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/v2`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 423);
  });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 401);
  }, { commandQueue: createFakeQueue(), commandsEnabled: true });
});

test('command queue accepts once, treats an identical resend as duplicate, and rejects an ID collision', async () => {
  const commandQueue = createFakeQueue();
  const baseBody = { action: 'enqueueCommand', requestId: 'sale-1', command: { requestId: 'sale-1', type: 'sale', amount: 55300 } };
  await withServer(createFakeStore(), async (base) => {
    const post = async (body) => fetch(`${base}/api/v2`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const first = await post(baseBody);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { ok: true, accepted: true, duplicate: false, status: 'pending' });
    const duplicate = await post(baseBody);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    const collision = await post({ ...baseBody, command: { ...baseBody.command, amount: 1 } });
    assert.equal(collision.status, 409);
    assert.deepEqual(await collision.json(), { ok: false, error: 'requestId collision' });
  }, { commandQueue, commandsEnabled: true });
});

test('Chat intake forwards a stable business event key and reports cross-source duplicates as not newly accepted', async () => {
  let received;
  const commandQueue = {
    async enqueue(input) {
      received = input;
      return {
        status: 'duplicate', accepted: false, duplicate: true,
        businessDuplicate: true, existingRequestId: 'gmail-request-1'
      };
    }
  };
  const body = {
    action: 'enqueueCommand', requestId: 'chat-request-2',
    businessEventKey: 'lottery:store-a:round-1:application',
    command: { requestId: 'chat-request-2', type: 'lottery', product: 'MEGA Dream ex' }
  };
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/api/v2/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, accepted: false, duplicate: true, status: 'duplicate', existingRequestId: 'gmail-request-1'
    });
    assert.equal(received.businessEventKey, body.businessEventKey);
    assert.equal(received.requestId, body.requestId);
  }, { commandQueue, commandsEnabled: true });
});

test('Chat intake derives a source-independent key from an explicit lottery application ID', async () => {
  let received;
  const commandQueue = {
    async enqueue(input) { received = input; return { status: 'pending', accepted: true, duplicate: false }; }
  };
  const body = {
    action: 'enqueueCommand', requestId: 'chat-lottery-3',
    businessEventIdentity: { retailerKey: ' Store A ', applicationId: 'ENTRY-123' },
    command: { requestId: 'chat-lottery-3', type: 'lottery', title: 'MEGA Dream ex', store: 'Store A' }
  };
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/api/v2/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 202);
    assert.equal(received.businessEventKey, createLotteryBusinessEventKey({
      kind: 'application', retailerKey: ' Store A ', applicationId: 'ENTRY-123'
    }).businessEventKey);
    assert.equal(received.businessEventKey.includes('ENTRY-123'), false);
  }, { commandQueue, commandsEnabled: true });
});

test('Chat intake routes lottery identity without an external application ID to review and does not queue it', async () => {
  let enqueueCalls = 0;
  const commandQueue = { async enqueue() { enqueueCalls++; return { status: 'pending', accepted: true }; } };
  await withServer(createFakeStore(), async (base) => {
    const response = await fetch(`${base}/api/v2/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'enqueueCommand', requestId: 'chat-lottery-4',
        businessEventIdentity: { retailerKey: 'store-a' },
        command: { requestId: 'chat-lottery-4', type: 'lottery', title: 'MEGA Dream ex', store: 'Store A' }
      })
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      ok: false, accepted: false, status: 'review', reasonCode: 'lottery-identity-incomplete'
    });
    assert.equal(enqueueCalls, 0);
  }, { commandQueue, commandsEnabled: true });
});

test('Chat command status reports accepted, processed, and readback states without exposing the command', async () => {
  const commandQueue = createFakeQueue();
  const command = { requestId: 'chat-application-1', type: 'lottery', product: 'private product name' };
  await withServer(createFakeStore(), async (base) => {
    const post = await fetch(`${base}/api/v2/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: command.requestId, command })
    });
    assert.equal(post.status, 202);
    assert.equal((await post.json()).status, 'pending');

    const pendingResponse = await fetch(`${base}/api/v2/commands/${encodeURIComponent(command.requestId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const pending = await pendingResponse.json();
    assert.deepEqual(pending, {
      ok: true, found: true, status: 'pending', acceptedAtMs: 100, updatedAtMs: 100,
      resultCode: null, processed: false, canonicalReadbackVerified: false
    });
    assert.equal(JSON.stringify(pending).includes('private product name'), false);

    commandQueue.setStatus(command.requestId, 'done', 'v2-applied');
    const doneResponse = await fetch(`${base}/api/v2/commands/${encodeURIComponent(command.requestId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const done = await doneResponse.json();
    assert.equal(done.processed, true);
    assert.equal(done.canonicalReadbackVerified, true);

    const missing = await fetch(`${base}/api/v2/commands/not-created`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.deepEqual(await missing.json(), { ok: true, found: false, status: 'not-found' });
  }, { commandQueue, commandsEnabled: true });
});

test('V2 reads require bearer auth and do not expose tokens in query strings', async () => {
  const initial = emptyV2();
  const store = createFakeStore({ payload: initial, revision: 0, lastMutationId: '' });
  await withServer(store, async (base) => {
    const denied = await fetch(`${base}/api/v2?token=${TOKEN}`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${base}/api/v2`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.revision, 0);
    assert.equal(body.payload.schemaVersion, 2);
  });
});

test('browser CORS rejects unknown origins and allows only configured origins', async () => {
  await withServer(createFakeStore(), async (base) => {
    const denied = await fetch(`${base}/api/v2`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${base}/api/v2`, { method: 'OPTIONS', headers: { origin: 'https://example.test' } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.test');
  });
});
