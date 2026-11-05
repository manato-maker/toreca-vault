import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../cloud/src/server.js';
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
