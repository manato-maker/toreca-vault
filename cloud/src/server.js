import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  CanonicalNotInitialized,
  RevisionConflict,
  createFirestoreStore
} from './firestore-store.js';

const MAX_BODY_BYTES = 1_100_000;

function parseOrigins(value) {
  return new Set(String(value || '').split(',').map((origin) => origin.trim()).filter(Boolean));
}

function isAuthorized(request, expectedToken) {
  const header = String(request.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !expectedToken) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expectedToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, status, body, origin = '') {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'vary': 'Origin'
    } : {})
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function errorResponse(error) {
  if (error instanceof RevisionConflict) {
    return { status: 409, body: { ok: false, conflict: true, error: error.message, revision: error.currentRevision } };
  }
  if (error instanceof CanonicalNotInitialized) {
    return { status: 503, body: { ok: false, error: 'canonical V2 state is not initialized' } };
  }
  if (error?.statusCode) return { status: error.statusCode, body: { ok: false, error: error.message } };
  return { status: 400, body: { ok: false, error: error?.message || 'request failed' } };
}

export function createServer({ store, commandQueue = null, apiToken, allowedOrigins = new Set(), writesEnabled = false, commandsEnabled = false }) {
  if (!store || typeof store.read !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('a V2 state store is required');
  }
  const origins = allowedOrigins instanceof Set ? allowedOrigins : parseOrigins(allowedOrigins);

  return http.createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const requestOrigin = String(request.headers.origin || '');
    const allowedOrigin = requestOrigin && origins.has(requestOrigin) ? requestOrigin : '';

    if (request.method === 'OPTIONS') {
      if (!allowedOrigin) return send(response, 403, { ok: false, error: 'origin not allowed' });
      response.writeHead(204, {
        'access-control-allow-origin': allowedOrigin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        'vary': 'Origin'
      });
      return response.end();
    }

    if (path === '/health' && request.method === 'GET') {
      try {
        const current = await store.read();
        return send(response, 200, {
          ok: true,
          service: 'toreca-vault-v2-api',
          canonicalInitialized: Boolean(current),
          writesEnabled: Boolean(writesEnabled)
        });
      } catch {
        return send(response, 503, {
          ok: false,
          service: 'toreca-vault-v2-api',
          canonicalInitialized: false,
          writesEnabled: Boolean(writesEnabled)
        });
      }
    }

    const commandStatusPath = /^\\/api\\/v2\\/commands\\/([^/]+)$/.exec(path);
    const commandRoute = path === '/api/v2/commands' || commandStatusPath;
    const knownApiRoute = path === '/api/v2' || commandRoute;
    const knownMethod = (path === '/api/v2' && ['GET', 'POST'].includes(request.method))
      || (path === '/api/v2/commands' && request.method === 'POST')
      || (Boolean(commandStatusPath) && request.method === 'GET');
    if (!knownApiRoute || !knownMethod) {
      return send(response, 404, { ok: false, error: 'not found' }, allowedOrigin);
    }
    if (requestOrigin && !allowedOrigin) return send(response, 403, { ok: false, error: 'origin not allowed' });
    if (!isAuthorized(request, apiToken)) return send(response, 401, { ok: false, error: 'unauthorized' }, allowedOrigin);

    try {
      if (commandStatusPath && request.method === 'GET') {
        if (!commandsEnabled || !commandQueue || typeof commandQueue.inspect !== 'function') {
          return send(response, 423, { ok: false, error: 'command queue status is disabled' }, allowedOrigin);
        }
        let requestId;
        try { requestId = decodeURIComponent(commandStatusPath[1]).trim(); }
        catch { return send(response, 400, { ok: false, error: 'invalid requestId' }, allowedOrigin); }
        if (!requestId || requestId.length > 200) {
          return send(response, 400, { ok: false, error: 'invalid requestId' }, allowedOrigin);
        }
        const record = await commandQueue.inspect(requestId);
        if (!record) return send(response, 200, { ok: true, found: false, status: 'not-found' }, allowedOrigin);
        const canonicalReadbackVerified = record.status === 'done'
          && ['v2-applied', 'duplicate-already-applied'].includes(record.resultCode);
        return send(response, 200, {
          ok: true,
          found: true,
          status: String(record.status || 'unknown'),
          acceptedAtMs: Number.isFinite(record.createdAtMs) ? record.createdAtMs : null,
          updatedAtMs: Number.isFinite(record.updatedAtMs) ? record.updatedAtMs : null,
          resultCode: /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(String(record.resultCode || ''))
            ? record.resultCode : null,
          processed: ['done', 'review'].includes(record.status),
          canonicalReadbackVerified
        }, allowedOrigin);
      }

      if (request.method === 'GET') {
        const current = await store.read();
        if (!current) throw new CanonicalNotInitialized();
        return send(response, 200, {
          ok: true,
          payload: current.payload,
          revision: current.revision,
          lastMutationId: current.lastMutationId
        }, allowedOrigin);
      }

      const body = await readBody(request);
      if (body.action === 'load') {
        const current = await store.read();
        if (!current) throw new CanonicalNotInitialized();
        return send(response, 200, {
          ok: true,
          payload: current.payload,
          revision: current.revision,
          lastMutationId: current.lastMutationId
        }, allowedOrigin);
      }

      if (path === '/api/v2/commands' || body.action === 'enqueueCommand') {
        if (!commandsEnabled || !commandQueue) {
          return send(response, 423, { ok: false, error: 'command queue is disabled' }, allowedOrigin);
        }
        const queued = await commandQueue.enqueue({ requestId: body.requestId, command: body.command });
        if (!queued.accepted) {
          return send(response, 409, { ok: false, error: 'requestId collision' }, allowedOrigin);
        }
        return send(response, queued.duplicate ? 200 : 202, {
          ok: true,
          accepted: true,
          duplicate: Boolean(queued.duplicate),
          status: queued.status
        }, allowedOrigin);
      }

      if (!writesEnabled) {
        return send(response, 423, { ok: false, error: 'writes are disabled until migration acceptance' }, allowedOrigin);
      }

      const saved = await store.save(body);
      return send(response, 200, {
        ok: true,
        duplicate: saved.duplicate,
        payload: saved.payload,
        revision: saved.revision,
        lastMutationId: saved.lastMutationId
      }, allowedOrigin);
    } catch (error) {
      const result = errorResponse(error);
      return send(response, result.status, result.body, allowedOrigin);
    }
  });
}

export async function start() {
  const token = process.env.TV2_API_TOKEN || '';
  if (token.length < 32) throw new Error('TV2_API_TOKEN must contain at least 32 characters');
  const documentPath = process.env.TV2_FIRESTORE_DOCUMENT || 'torecaVaultV2/canonical';
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const { createFirestoreCommandQueue } = await import('./firestore-command-queue.js');
  const server = createServer({
    store: createFirestoreStore(firestore, documentPath),
    commandQueue: createFirestoreCommandQueue(firestore),
    apiToken: token,
    allowedOrigins: parseOrigins(process.env.TV2_ALLOWED_ORIGINS),
    writesEnabled: process.env.TV2_ENABLE_WRITES === 'true',
    commandsEnabled: process.env.TV2_ENABLE_COMMAND_QUEUE === 'true'
  });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`Toreca Vault V2 API listening on ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
