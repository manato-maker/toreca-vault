import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dashboardReadModel } from './dashboard-data.js';
import { createLotteryBusinessEventKey } from './business-event-identity.js';
import { createCommandBatchWorker } from './command-batch-worker.js';
import { createGoogleSchedulerAuthorizer } from './google-scheduler-authorizer.js';
import { createGoogleSheetsIntakeProcessor } from './google-sheets-intake.js';
import { createGoogleSheetsIntakeStatusProcessor } from './google-sheets-intake-status.js';
import { createInventorySheetSync } from './inventory-sheet.js';
import { createGoogleSheetsIntakeProvider } from './google-sheets-intake-provider.js';
import { createFirestoreGoogleSheetsIntakeCursorStore } from './firestore-google-sheets-intake-cursor.js';
import {
  createFirestoreSchedulerHeartbeatStore,
  evaluateSchedulerHealth
} from './scheduler-heartbeat.js';
import {
  CanonicalNotInitialized,
  RevisionConflict,
  createFirestoreStore
} from './firestore-store.js';
import { parseSchedulerScheduleTime } from './scheduled-runtime.js';

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

export function createServer({
  store,
  commandQueue = null,
  commandWorker = null,
  workerAuthorize = null,
  sheetsIntakeWorker = null,
  sheetsIntakeAuthorize = null,
  sheetsIntakeEnabled = false,
  schedulerHealth = null,
  schedulerTick = null,
  schedulerAuthorize = null,
  apiToken,
  dashboardAuthorize = null,
  dashboardGoogleClientId = '',
  allowedOrigins = new Set(),
  writesEnabled = false,
  commandsEnabled = false
}) {
  if (!store || typeof store.read !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('a V2 state store is required');
  }
  const origins = allowedOrigins instanceof Set ? allowedOrigins : parseOrigins(allowedOrigins);

  return http.createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const requestOrigin = String(request.headers.origin || '');
    const allowedOrigin = requestOrigin && origins.has(requestOrigin) ? requestOrigin : '';

    const staticFiles = new Map([
      ['/', ['index.html', 'text/html; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
    ]);
    if (request.method === 'GET' && staticFiles.has(path)) {
      const [file, contentType] = staticFiles.get(path);
      try {
        const body = await readFile(new URL('../public/' + file, import.meta.url));
        response.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        });
        response.end(body);
      } catch {
        send(response, 503, { ok: false, error: 'dashboard files are unavailable' });
      }
      return;
    }
    if (request.method === 'GET' && path === '/app-config.js') {
      const body = 'window.TV2_APP_CONFIG = ' + JSON.stringify({ googleClientId: dashboardGoogleClientId }) + ';';
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      response.end(body);
      return;
    }

    if (path === '/api/v2/dashboard') {
      if (request.method !== 'GET') return send(response, 405, { ok: false, error: 'method not allowed' }, allowedOrigin);
      if (typeof dashboardAuthorize !== 'function') {
        return send(response, 503, { ok: false, error: 'dashboard sign-in is not configured' }, allowedOrigin);
      }
      try {
        if (!await dashboardAuthorize(request)) return send(response, 401, { ok: false, error: 'sign-in required' }, allowedOrigin);
        const current = await store.read();
        if (!current) throw new CanonicalNotInitialized();
        return send(response, 200, dashboardReadModel(current.payload), allowedOrigin);
      } catch (error) {
        const result = errorResponse(error);
        return send(response, result.status, result.body, allowedOrigin);
      }
    }

    if (path === '/internal/worker/sheets-intake') {
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method not allowed' });
      if (!commandsEnabled || !sheetsIntakeEnabled || typeof sheetsIntakeWorker !== 'function'
        || typeof sheetsIntakeAuthorize !== 'function') {
        return send(response, 503, { ok: false, error: 'Google Sheets intake is disabled' });
      }
      try {
        if (!await sheetsIntakeAuthorize(request)) return send(response, 401, { ok: false, error: 'unauthorized' });
      } catch {
        return send(response, 503, { ok: false, error: 'intake authorization unavailable' });
      }
      if (String(request.headers['x-cloudscheduler'] || '').toLowerCase() !== 'true') {
        return send(response, 400, { ok: false, error: 'missing scheduler marker' });
      }
      let scheduledAt;
      try {
        scheduledAt = parseSchedulerScheduleTime(request.headers['x-cloudscheduler-scheduletime']);
      } catch {
        return send(response, 400, { ok: false, error: 'invalid scheduler time' });
      }
      try {
        const result = await sheetsIntakeWorker({ scheduledAt, triggeredAt: new Date() });
        const counts = {};
        for (const key of ['seen', 'enqueued', 'duplicate', 'review', 'skipped']) {
          counts[key] = Number.isSafeInteger(result?.[key]) && result[key] >= 0 ? result[key] : 0;
        }
        const body = { ok: true, scheduledAt: scheduledAt.toISOString(), ...counts };
        if (result?.statusReconciliation && typeof result.statusReconciliation === 'object') {
          for (const key of ['checked', 'finalized', 'pending']) {
            body[`status${key[0].toUpperCase()}${key.slice(1)}`] = Number.isSafeInteger(result.statusReconciliation[key])
              && result.statusReconciliation[key] >= 0 ? result.statusReconciliation[key] : 0;
          }
        }
        if (result?.inventory && typeof result.inventory === 'object') {
          body.inventoryRows = Number.isSafeInteger(result.inventory.rowCount) ? result.inventory.rowCount : 0;
          body.inventoryRevision = Number.isSafeInteger(result.inventory.revision) ? result.inventory.revision : null;
        }
        return send(response, 200, body);
      } catch {
        return send(response, 503, { ok: false, error: 'Google Sheets intake failed' });
      }
    }

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

    if (path === '/internal/scheduler/tick') {
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method not allowed' });
      if (typeof schedulerTick !== 'function' || typeof schedulerAuthorize !== 'function') {
        return send(response, 503, { ok: false, error: 'scheduler route is disabled' });
      }
      try {
        if (!await schedulerAuthorize(request)) return send(response, 401, { ok: false, error: 'unauthorized' });
      } catch {
        return send(response, 503, { ok: false, error: 'scheduler authorization unavailable' });
      }
      if (String(request.headers['x-cloudscheduler'] || '').toLowerCase() !== 'true') {
        return send(response, 400, { ok: false, error: 'missing scheduler marker' });
      }
      let scheduledAt;
      try {
        scheduledAt = parseSchedulerScheduleTime(request.headers['x-cloudscheduler-scheduletime']);
      } catch {
        return send(response, 400, { ok: false, error: 'invalid scheduler time' });
      }
      try {
        const result = await schedulerTick({ scheduledAt, triggeredAt: new Date() });
        const failedJobCount = Number.isSafeInteger(result?.failedJobCount) && result.failedJobCount >= 0
          ? result.failedJobCount : 0;
        const ok = failedJobCount === 0;
        return send(response, ok ? 200 : 503, {
          ok,
          scheduledAt: scheduledAt.toISOString(),
          plannedCount: Number.isSafeInteger(result?.plannedCount) ? result.plannedCount : 0,
          failedJobCount
        });
      } catch {
        return send(response, 503, { ok: false, error: 'scheduled tick failed' });
      }
    }

    if (path === '/internal/worker/commands') {
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method not allowed' });
      if (!writesEnabled || !commandsEnabled || typeof commandWorker !== 'function' || typeof workerAuthorize !== 'function') {
        return send(response, 503, { ok: false, error: 'command worker is disabled' });
      }
      try {
        if (!await workerAuthorize(request)) return send(response, 401, { ok: false, error: 'unauthorized' });
      } catch {
        return send(response, 503, { ok: false, error: 'worker authorization unavailable' });
      }
      if (String(request.headers['x-cloudscheduler'] || '').toLowerCase() !== 'true') {
        return send(response, 400, { ok: false, error: 'missing scheduler marker' });
      }
      let scheduledAt;
      try {
        scheduledAt = parseSchedulerScheduleTime(request.headers['x-cloudscheduler-scheduletime']);
      } catch {
        return send(response, 400, { ok: false, error: 'invalid scheduler time' });
      }
      try {
        const result = await commandWorker({ scheduledAt, triggeredAt: new Date() });
        const processedCount = Number.isSafeInteger(result?.processedCount) && result.processedCount >= 0 ? result.processedCount : 0;
        return send(response, 200, {
          ok: true,
          scheduledAt: scheduledAt.toISOString(),
          processedCount,
          doneCount: Number.isSafeInteger(result?.done) ? result.done : 0,
          pendingCount: Number.isSafeInteger(result?.pending) ? result.pending : 0,
          reviewCount: Number.isSafeInteger(result?.review) ? result.review : 0,
          busyCount: Number.isSafeInteger(result?.busy) ? result.busy : 0
        });
      } catch {
        return send(response, 503, { ok: false, error: 'command batch failed' });
      }
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

    if (path === '/health/scheduler' && request.method === 'GET') {
      if (typeof schedulerHealth !== 'function') {
        return send(response, 503, { ok: false, error: 'scheduler health is not configured' });
      }
      try {
        const health = await schedulerHealth();
        const body = {
          ok: false,
          stale: health ? Boolean(health.stale) : true,
          lastScheduledAtMs: Number.isSafeInteger(health?.lastScheduledAtMs) ? health.lastScheduledAtMs : null,
          lastCompletedAtMs: Number.isSafeInteger(health?.lastCompletedAtMs) ? health.lastCompletedAtMs : null,
          ageMs: Number.isSafeInteger(health?.ageMs) ? health.ageMs : null,
          latestMissedSlots: Number.isSafeInteger(health?.latestMissedSlots) ? health.latestMissedSlots : 0,
          failedJobCount: Number.isSafeInteger(health?.failedJobCount) ? health.failedJobCount : 0
        };
        body.ok = Boolean(health?.healthy) && !body.stale
          && body.lastCompletedAtMs !== null
          && body.latestMissedSlots === 0 && body.failedJobCount === 0;
        return send(response, body.ok ? 200 : 503, body);
      } catch {
        return send(response, 503, { ok: false, error: 'scheduler health unavailable' });
      }
    }

    const commandStatusSuffix = path.startsWith('/api/v2/commands/')
      ? path.slice('/api/v2/commands/'.length) : '';
    const commandStatusPath = commandStatusSuffix && !commandStatusSuffix.includes('/')
      ? commandStatusSuffix : '';
    const commandRoute = path === '/api/v2/commands' || Boolean(commandStatusPath);
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
        try { requestId = decodeURIComponent(commandStatusPath).trim(); }
        catch { return send(response, 400, { ok: false, error: 'invalid requestId' }, allowedOrigin); }
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)) {
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
        let businessEventKey = body.businessEventKey;
        if (body.businessEventIdentity !== undefined) {
          if (businessEventKey !== undefined) {
            return send(response, 400, { ok: false, error: 'provide businessEventIdentity or businessEventKey, not both' }, allowedOrigin);
          }
          const identity = body.businessEventIdentity;
          if (!identity || typeof identity !== 'object' || Array.isArray(identity)
            || Object.keys(identity).some((key) => !['retailerKey', 'applicationId'].includes(key))) {
            return send(response, 400, { ok: false, error: 'business event identity is invalid' }, allowedOrigin);
          }
          const eventKinds = {
            lottery: 'application',
            'lottery-result-exact': 'result',
            'lottery-receipt': 'receipt'
          };
          const kind = eventKinds[String(body.command?.type || '')];
          if (!kind) return send(response, 400, { ok: false, error: 'business event identity is unsupported for this command' }, allowedOrigin);
          const resolved = createLotteryBusinessEventKey({ ...identity, kind });
          if (resolved.status === 'review') {
            return send(response, 422, { ok: false, accepted: false, status: 'review', reasonCode: resolved.reasonCode }, allowedOrigin);
          }
          businessEventKey = resolved.businessEventKey;
        }
        const queued = await commandQueue.enqueue({
          requestId: body.requestId,
          command: body.command,
          businessEventKey
        });
        if (queued.businessDuplicate) {
          return send(response, 200, {
            ok: true,
            accepted: false,
            duplicate: true,
            status: 'duplicate',
            existingRequestId: queued.existingRequestId
          }, allowedOrigin);
        }
        if (!queued.accepted) {
          const error = queued.status === 'business-event-collision'
            ? 'business event identity conflicts with an existing command'
            : 'requestId collision';
          return send(response, 409, { ok: false, error }, allowedOrigin);
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
  const commandQueue = createFirestoreCommandQueue(firestore);
  const store = createFirestoreStore(firestore, documentPath);
  const heartbeatStore = createFirestoreSchedulerHeartbeatStore(firestore);
  const writesEnabled = process.env.TV2_ENABLE_WRITES === 'true';
  const commandsEnabled = process.env.TV2_ENABLE_COMMAND_QUEUE === 'true';
  const commandWorkerEnabled = process.env.TV2_ENABLE_COMMAND_WORKER === 'true';
  const dashboardGoogleClientId = process.env.TV2_GOOGLE_OAUTH_CLIENT_ID || '';
  const dashboardViewerEmail = String(process.env.TV2_DASHBOARD_VIEWER_EMAIL || '').trim().toLowerCase();
  let dashboardAuthorize = null;
  if (dashboardGoogleClientId && dashboardViewerEmail) {
    const { OAuth2Client } = await import('google-auth-library');
    const dashboardOAuthClient = new OAuth2Client(dashboardGoogleClientId);
    dashboardAuthorize = async (request) => {
      const header = String(request.headers.authorization || '');
      const credential = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!credential) return false;
      try {
        const ticket = await dashboardOAuthClient.verifyIdToken({
          idToken: credential,
          audience: dashboardGoogleClientId
        });
        const claims = ticket.getPayload();
        return claims?.email_verified === true
          && String(claims.email || '').trim().toLowerCase() === dashboardViewerEmail;
      } catch {
        return false;
      }
    };
  }
  const sheetsIntakeEnabled = process.env.TV2_ENABLE_GOOGLE_SHEETS_INTAKE === 'true';
  const inventoryViewEnabled = process.env.TV2_ENABLE_INVENTORY_VIEW === 'true';
  if (inventoryViewEnabled && !sheetsIntakeEnabled) {
    throw new Error('inventory view requires Google Sheets intake to be explicitly enabled');
  }
  if (commandWorkerEnabled && (!writesEnabled || !commandsEnabled)) {
    throw new Error('command worker requires both writes and command queue to be explicitly enabled');
  }
  if (sheetsIntakeEnabled && !commandsEnabled) {
    throw new Error('Google Sheets intake requires the command queue to be explicitly enabled');
  }
  const schedulerAudience = process.env.TV2_SCHEDULER_AUDIENCE || '';
  const schedulerServiceAccountEmail = process.env.TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL || '';
  const scheduledWorkerEnabled = commandWorkerEnabled || sheetsIntakeEnabled;
  if (scheduledWorkerEnabled && (!schedulerAudience.startsWith('https://') || !schedulerServiceAccountEmail)) {
    throw new Error('scheduled workers require TV2_SCHEDULER_AUDIENCE and TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL');
  }
  const scheduledWorkerAuthorize = scheduledWorkerEnabled
    ? createGoogleSchedulerAuthorizer({
      verifier: new (await import('google-auth-library')).OAuth2Client(),
      audience: schedulerAudience,
      serviceAccountEmail: schedulerServiceAccountEmail
    })
    : null;
  const workerAuthorize = commandWorkerEnabled ? scheduledWorkerAuthorize : null;
  const commandWorker = commandWorkerEnabled
    ? createCommandBatchWorker({ queue: commandQueue, store })
    : null;
  let sheetsIntakeWorker = null;
  if (sheetsIntakeEnabled) {
    const spreadsheetId = process.env.TV2_NEW_APP_INTAKE_SPREADSHEET_ID || '';
    if (!spreadsheetId) throw new Error('TV2_NEW_APP_INTAKE_SPREADSHEET_ID is required when Sheets intake is enabled');
    const { GoogleAuth } = await import('google-auth-library');
    const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheetsClient = await googleAuth.getClient();
    const provider = createGoogleSheetsIntakeProvider({
      spreadsheetId,
      getAccessToken: async () => (await sheetsClient.getAccessToken()).token
    });
    const cursorStore = createFirestoreGoogleSheetsIntakeCursorStore(firestore, spreadsheetId);
    const intakeWorker = createGoogleSheetsIntakeProcessor({
      provider, queue: commandQueue, cursorStore, spreadsheetId, maxRowsPerRun: 20
    });
    const statusWorker = createGoogleSheetsIntakeStatusProcessor({ provider, queue: commandQueue, spreadsheetId, maxRowsPerRun: 20 });
    const inventorySync = inventoryViewEnabled
      ? createInventorySheetSync({ store, spreadsheetId, getAccessToken: async () => (await sheetsClient.getAccessToken()).token })
      : null;
    sheetsIntakeWorker = async (input) => {
      const intake = await intakeWorker(input);
      const statusReconciliation = await statusWorker(input);
      const inventory = inventorySync ? await inventorySync.sync() : null;
      return { ...intake, statusReconciliation, inventory };
    };
  }
  const server = createServer({
    store,
    commandQueue,
    commandWorker,
    workerAuthorize,
    sheetsIntakeWorker,
    sheetsIntakeAuthorize: sheetsIntakeEnabled ? scheduledWorkerAuthorize : null,
    sheetsIntakeEnabled,
    schedulerHealth: async () => evaluateSchedulerHealth(await heartbeatStore.read()),
    apiToken: token,
    dashboardAuthorize,
    dashboardGoogleClientId,
    allowedOrigins: parseOrigins(process.env.TV2_ALLOWED_ORIGINS),
    writesEnabled,
    commandsEnabled
  });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`Toreca Vault V2 API listening on ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
