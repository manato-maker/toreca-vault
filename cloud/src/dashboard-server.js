import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from './firestore-store.js';
import { createIapVerifier } from './dashboard-auth.js';
import { renderDashboard } from './dashboard-view.js';

const securityHeaders = {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

function reply(response, status, content, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { ...securityHeaders, 'content-type': contentType });
  response.end(content);
}

export function createDashboardServer({ store, verifyIap, now = () => new Date(), handoverDocId = '' }) {
  if (typeof store?.read !== 'function') throw new TypeError('read-only store is required');
  if (typeof verifyIap !== 'function') throw new TypeError('signed IAP verifier is required');

  return http.createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url || '/', 'http://localhost'); }
    catch { return reply(response, 400, 'Invalid URL'); }
    if (url.pathname !== '/' && url.pathname !== '/app') return reply(response, 404, 'Not found');
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, 'Method not allowed');
    if (!request.headers['x-goog-iap-jwt-assertion']) return reply(response, 401, 'Google login required');
    let allowed = false;
    try { allowed = await verifyIap(request); }
    catch { allowed = false; }
    if (!allowed) return reply(response, 403, 'Access denied');
    try {
      const snapshot = await store.read();
      if (!snapshot?.payload) return reply(response, 503, 'Staging data is not initialized');
      const html = renderDashboard(snapshot.payload, snapshot.revision, url.searchParams.get('month') || '', now(), url.searchParams.get('type') || 'all', handoverDocId);
      if (request.method === 'HEAD') {
        response.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' });
        return response.end();
      }
      return reply(response, 200, html, 'text/html; charset=utf-8');
    } catch {
      return reply(response, 503, 'Unable to read staging data');
    }
  });
}

export async function startDashboard() {
  // This service is deliberately distinct from the API/worker Cloud Run
  // service, so enabling IAP won't interrupt Scheduler OIDC invocations.
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || '';
  const documentPath = process.env.TV2_FIRESTORE_DOCUMENT || '';
  if (projectId !== 'project-8ff0bbc4-675d-4596-a8a'
    || documentPath !== 'torecaVaultStaging/canonical') {
    throw new Error('dashboard only supports the isolated staging canonical document');
  }
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ projectId });
  const store = createFirestoreStore(firestore, documentPath);
  const verifyIap = createIapVerifier({
    audience: process.env.TV2_DASHBOARD_IAP_AUDIENCE,
    allowedEmails: process.env.TV2_DASHBOARD_ALLOWED_EMAILS
  });
  const server = createDashboardServer({ store, verifyIap, handoverDocId: process.env.TV2_HANDOVER_DOC_ID || '' });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => console.log('Toreca Vault staging dashboard listening'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDashboard().catch(() => { console.error('Dashboard startup failed: configuration or Firestore unavailable'); process.exitCode = 1; });
}
