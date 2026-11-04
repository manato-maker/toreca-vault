import { createQuotaAwareGmailProvider } from './quota-aware-gmail-provider.js';

const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function accessToken(value) {
  const token = typeof value === 'string' ? value : value?.access_token ?? value?.token;
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('OAuth token provider returned no access token');
  return token;
}

function responseReasons(body) {
  const values = body?.error?.errors;
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => item?.reason)
    .filter((reason) => typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(reason));
}

function apiError(status, body, headers) {
  const error = new Error('Gmail API request failed');
  error.name = 'GmailApiError';
  error.status = status;
  error.errors = responseReasons(body).map((reason) => ({ reason }));
  if (headers) error.headers = headers;
  return error;
}

/** Gmail list adapter. Supply an OAuth token source limited to GMAIL_READONLY_SCOPE. */
export function createGoogleGmailApiProvider({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  sleep,
  random,
  now,
  maxRetries = 4,
  baseDelayMs = 1000,
  maxDelayMs = 30_000,
  requestTimeoutMs = 30_000
} = {}) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new TypeError('requestTimeoutMs must be from 1 to 120000');
  }

  const request = async ({ query, maxResults, pageToken }) => {
    const token = accessToken(await getAccessToken({ scopes: [GMAIL_READONLY_SCOPE] }));
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetchImpl(`${GMAIL_API_ROOT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (!response || !Number.isInteger(response.status)) throw new TypeError('Gmail API returned an invalid response');
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch {}
      throw apiError(response.status, body, response.headers);
    }

    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Gmail API returned an invalid page');
    }
    const rawMessages = data.messages ?? [];
    if (!Array.isArray(rawMessages)) throw new TypeError('Gmail API returned an invalid message list');
    const messages = rawMessages.map((message) => {
      if (!message || typeof message.id !== 'string' || !message.id.trim() || message.id.length > 512) {
        throw new TypeError('Gmail API returned an invalid message ID');
      }
      return { id: message.id };
    });
    const nextPageToken = data.nextPageToken == null ? null : String(data.nextPageToken);
    if (nextPageToken && nextPageToken.length > 2048) throw new TypeError('Gmail API returned an oversized page token');
    return { messages, nextPageToken };
  };

  const quotaAware = createQuotaAwareGmailProvider({
    request,
    ...(sleep ? { sleep } : {}),
    ...(random ? { random } : {}),
    ...(now ? { now } : {}),
    maxRetries,
    baseDelayMs,
    maxDelayMs
  });
  return { listMessages: quotaAware.listMessages };
}
