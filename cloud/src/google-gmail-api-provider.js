import { Buffer } from 'node:buffer';
import { createQuotaAwareGmailProvider } from './quota-aware-gmail-provider.js';

const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_CLASSIFIER_TEXT_BYTES = 512 * 1024;
const MAX_MIME_PARTS = 128;
const MAX_MIME_DEPTH = 8;

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

function headerValue(headers, wantedName) {
  if (!Array.isArray(headers)) return '';
  const item = headers.find((entry) => String(entry?.name || '').toLowerCase() === wantedName);
  return typeof item?.value === 'string' ? item.value.slice(0, 8192) : '';
}

function decodeBody(data) {
  if (typeof data !== 'string' || data.length > MAX_CLASSIFIER_TEXT_BYTES * 2) {
    throw new RangeError('Gmail message part exceeds the classifier limit');
  }
  const decoded = Buffer.from(data, 'base64url');
  if (decoded.byteLength > MAX_CLASSIFIER_TEXT_BYTES) throw new RangeError('Gmail message part exceeds the classifier limit');
  return decoded;
}

function extractPlainText(payload) {
  const collected = [];
  let totalBytes = 0;
  let partCount = 0;
  const visit = (part, depth) => {
    if (!part || typeof part !== 'object') return;
    partCount += 1;
    if (partCount > MAX_MIME_PARTS || depth > MAX_MIME_DEPTH) {
      throw new RangeError('Gmail message MIME structure exceeds the classifier limit');
    }
    if (String(part.mimeType || '').toLowerCase() === 'text/plain' && typeof part.body?.data === 'string') {
      const bytes = decodeBody(part.body.data);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_CLASSIFIER_TEXT_BYTES) throw new RangeError('Gmail message text exceeds the classifier limit');
      collected.push(bytes.toString('utf8'));
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  };
  visit(payload, 0);
  return collected.join('\n').slice(0, MAX_CLASSIFIER_TEXT_BYTES);
}

function nestedPartFields(depth) {
  if (depth < 1) return '';
  return ',parts(mimeType,body(data),parts(mimeType,body(data)' + nestedPartFields(depth - 1) + '))';
}

function validMessageId(messageId) {
  return typeof messageId === 'string' && messageId.trim().length > 0
    && messageId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(messageId);
}

/** Gmail read-only REST adapter. Mail content is returned only for immediate classification. */
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

  const request = async ({ query, maxResults, pageToken, messageId }) => {
    const token = accessToken(await getAccessToken({ scopes: [GMAIL_READONLY_SCOPE] }));
    let url;
    if (messageId != null) {
      if (!validMessageId(messageId)) throw new TypeError('messageId is invalid');
      const params = new URLSearchParams({
        format: 'full',
        fields: 'id,payload(headers(name,value),mimeType,body(data)' + nestedPartFields(7) + ')'
      });
      url = GMAIL_API_ROOT + '/' + encodeURIComponent(messageId) + '?' + params.toString();
    } else {
      const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      if (pageToken) params.set('pageToken', pageToken);
      url = GMAIL_API_ROOT + '?' + params.toString();
    }

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
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
      throw new TypeError('Gmail API returned an invalid response body');
    }
    return data;
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
  return {
    async listMessages(query, options) {
      const data = await quotaAware.listMessages(query, options);
      const rawMessages = data.messages ?? [];
      if (!Array.isArray(rawMessages)) throw new TypeError('Gmail API returned an invalid message list');
      const messages = rawMessages.map((message) => {
        if (!message || !validMessageId(message.id)) throw new TypeError('Gmail API returned an invalid message ID');
        return { id: message.id };
      });
      const nextPageToken = data.nextPageToken == null ? null : data.nextPageToken;
      if (nextPageToken != null && (typeof nextPageToken !== 'string' || nextPageToken.length > 2048)) {
        throw new TypeError('Gmail API returned an invalid page token');
      }
      return { messages, nextPageToken };
    },
    async getMessageForClassification(messageId) {
      const data = await quotaAware.getMessage(messageId);
      if (data.id !== messageId || !data.payload || typeof data.payload !== 'object') {
        throw new TypeError('Gmail API returned an invalid message');
      }
      return {
        subject: headerValue(data.payload.headers, 'subject'),
        text: extractPlainText(data.payload)
      };
    }
  };
}
