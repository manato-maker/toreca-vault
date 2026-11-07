import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleGmailApiProvider, GMAIL_READONLY_SCOPE } from '../src/google-gmail-api-provider.js';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() { return body; }
  };
}

test('Gmail API adapter requests only message IDs with the readonly scope', async () => {
  let request;
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async ({ scopes }) => {
      assert.deepEqual(scopes, [GMAIL_READONLY_SCOPE]);
      return { token: 'access-token' };
    },
    fetchImpl: async (url, init) => {
      request = { url: new URL(url), init };
      return jsonResponse(200, {
        messages: [{ id: 'message-1', threadId: 'thread-private' }],
        nextPageToken: 'next-page'
      });
    },
    maxRetries: 0
  });

  const page = await provider.listMessages('after:100 before:200 {応募 当選}', {
    maxResults: 50,
    pageToken: 'previous-page'
  });
  assert.deepEqual(page, { messages: [{ id: 'message-1' }], nextPageToken: 'next-page' });
  assert.equal(request.url.origin, 'https://gmail.googleapis.com');
  assert.equal(request.url.pathname, '/gmail/v1/users/me/messages');
  assert.equal(request.url.searchParams.get('q'), 'after:100 before:200 {応募 当選}');
  assert.equal(request.url.searchParams.get('maxResults'), '50');
  assert.equal(request.url.searchParams.get('pageToken'), 'previous-page');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.authorization, 'Bearer access-token');
  assert.equal(request.init.headers.accept, 'application/json');
});

test('Gmail API adapter refreshes the injected token and retries quota responses', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const delays = [];
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async () => `token-${++tokenCalls}`,
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      assert.equal(init.headers.authorization, `Bearer token-${fetchCalls}`);
      if (fetchCalls === 1) {
        return jsonResponse(429, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { 'retry-after': '2' });
      }
      return jsonResponse(200, { messages: [] });
    },
    sleep: async (ms) => delays.push(ms),
    now: () => 0,
    maxRetries: 1,
    maxDelayMs: 1500
  });

  assert.deepEqual(await provider.listMessages('query', { maxResults: 1 }), {
    messages: [],
    nextPageToken: null
  });
  assert.equal(tokenCalls, 2);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(delays, [1500]);
});

test('Gmail API adapter does not retry auth failures or expose API response text', async () => {
  let calls = 0;
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async () => 'token',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(401, {
        error: {
          message: 'sensitive provider response',
          errors: [{ reason: 'authError' }]
        }
      });
    },
    sleep: async () => assert.fail('auth responses must not be retried')
  });

  await assert.rejects(provider.listMessages('query', { maxResults: 1 }), (error) => {
    assert.equal(error.name, 'GmailApiError');
    assert.equal(error.status, 401);
    assert.deepEqual(error.errors, [{ reason: 'authError' }]);
    assert.equal(error.message.includes('sensitive provider response'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('Gmail API adapter fails closed on malformed IDs and page tokens', async () => {
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async () => 'token',
    fetchImpl: async () => jsonResponse(200, { messages: [{ threadId: 'without-id' }] }),
    maxRetries: 0
  });
  await assert.rejects(provider.listMessages('query', { maxResults: 1 }), /invalid message ID/);
});
