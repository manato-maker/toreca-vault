import http from 'node:http';
import { GoogleAuth } from 'google-auth-library';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from './firestore-store.js';
import { createIapVerifier } from './dashboard-auth.js';
import { renderDashboard } from './dashboard-view.js';
import { dashboardClientScript } from './dashboard-client.js';

const DEFAULT_COMMON_HANDOVER_FILE_ID = '1j8Mu-oz84zWFE-HPDhcT1_Ah22itSCo7';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const HANDOVER_MAX_BYTES = 1_000_000;

async function fetchCommonHandoff(fileId, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(String(fileId || ''))) throw new Error('handoff source is not configured');
  const auth = new GoogleAuth({ scopes: [DRIVE_READ_SCOPE] });
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = typeof access === 'string' ? access : access?.token;
  if (!token) throw new Error('handoff read identity unavailable');
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId);
  const headers = { authorization: 'Bearer ' + token };
  const metadataResponse = await fetchImpl(url + '?fields=id%2CmimeType%2CmodifiedTime%2Cname', { headers });
  if (!metadataResponse.ok) throw new Error('handoff metadata unavailable');
  const metadata = await metadataResponse.json();
  if (metadata.mimeType !== 'text/markdown') throw new Error('handoff must be a Markdown file');
  const modifiedTime = String(metadata.modifiedTime || '');
  const contentResponse = await fetchImpl(url + '?alt=media', { headers });
  if (!contentResponse.ok) throw new Error('handoff content unavailable');
  const content = await contentResponse.text();
  if (Buffer.byteLength(content, 'utf8') > HANDOVER_MAX_BYTES) throw new Error('handoff is too large');
  return { content, modifiedTime, name: String(metadata.name || 'Common handoff') };
}

const securityHeaders = {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

function reply(response, status, content, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, { ...securityHeaders, ...extraHeaders, 'content-type': contentType });
  response.end(content);
}

export function createDashboardServer({ store, verifyIap, now = () => new Date(), handoverDocId = '', commonHandoverFileId = DEFAULT_COMMON_HANDOVER_FILE_ID, readHandoff = () => fetchCommonHandoff(commonHandoverFileId) }) {
  if (typeof store?.read !== 'function') throw new TypeError('read-only store is required');
  if (typeof verifyIap !== 'function') throw new TypeError('signed IAP verifier is required');

  return http.createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url || '/', 'http://localhost'); }
    catch { return reply(response, 400, 'Invalid URL'); }
    if (!['/', '/app', '/dashboard.js', '/api/handoff', '/api/handoff/download'].includes(url.pathname)) return reply(response, 404, 'Not found');
    if (url.pathname.startsWith('/api/') ? request.method !== 'GET' : (request.method !== 'GET' && request.method !== 'HEAD')) return reply(response, 405, 'Method not allowed');
    if (!request.headers['x-goog-iap-jwt-assertion']) return reply(response, 401, 'Google login required');
    let allowed = false;
    try { allowed = await verifyIap(request); }
    catch { allowed = false; }
    if (!allowed) return reply(response, 403, 'Access denied');
    if (url.pathname === '/dashboard.js') {
      response.writeHead(200, { ...securityHeaders, 'content-type': 'application/javascript; charset=utf-8' });
      return response.end(request.method === 'HEAD' ? undefined : dashboardClientScript);
    }
    if (url.pathname === '/api/handoff' || url.pathname === '/api/handoff/download') {
      try {
        const handoff = await readHandoff();
        if (typeof handoff?.content !== 'string') throw new Error('handoff content unavailable');
        if (url.pathname === '/api/handoff/download') {
          return reply(response, 200, handoff.content, 'text/markdown; charset=utf-8', {
            'content-disposition': 'attachment; filename="Toreca_Vault_Common_Handoff_2026-11-14.md"'
          });
        }
        return reply(response, 200, JSON.stringify(handoff), 'application/json; charset=utf-8');
      } catch {
        return reply(response, 503, JSON.stringify({ error: 'handoff_unavailable' }), 'application/json; charset=utf-8');
      }
    }
    try {
      const snapshot = await store.read();
      if (!snapshot?.payload) return reply(response, 503, 'Staging data is not initialized');
      const requestedView = url.searchParams.get('view') || (url.searchParams.has('date') ? 'calendar'
        : url.searchParams.has('type') ? 'history'
          : url.searchParams.has('month') ? 'calendar' : 'assets');
      const html = renderDashboard(snapshot.payload, snapshot.revision, url.searchParams.get('month') || '', now(), url.searchParams.get('type') || 'all', handoverDocId, url.searchParams.get('date') || '', requestedView);
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
  const server = createDashboardServer({ store, verifyIap, handoverDocId: process.env.TV2_HANDOVER_DOC_ID || '', commonHandoverFileId: process.env.TV2_COMMON_HANDOVER_FILE_ID || DEFAULT_COMMON_HANDOVER_FILE_ID });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => console.log('Toreca Vault staging dashboard listening'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDashboard().catch(() => { console.error('Dashboard startup failed: configuration or Firestore unavailable'); process.exitCode = 1; });
}
