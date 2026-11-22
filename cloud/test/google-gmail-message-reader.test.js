import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createGoogleGmailApiProvider, GMAIL_READONLY_SCOPE } from '../src/google-gmail-api-provider.js';

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), async json() { return body; } };
}

test('Gmail detail reader requests only bounded classifier fields and discards other headers', async () => {
  let captured;
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async ({ scopes }) => {
      assert.deepEqual(scopes, [GMAIL_READONLY_SCOPE]);
      return 'access-token';
    },
    fetchImpl: async (url, init) => {
      captured = { url: new URL(url), init };
      return jsonResponse(200, {
        id: 'message/1',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'private@example.test' },
            { name: 'Subject', value: 'ポケモンカード 抽選結果' }
          ],
          parts: [
            { mimeType: 'text/html', body: { data: Buffer.from('<b>html only</b>').toString('base64url') } },
            { mimeType: 'text/plain', body: { data: Buffer.from('当選しました').toString('base64url') } }
          ]
        }
      });
    },
    maxRetries: 0
  });

  const fields = await provider.getMessageForClassification('message/1');
  assert.deepEqual(fields, { subject: 'ポケモンカード 抽選結果', text: '当選しました' });
  assert.equal(captured.url.pathname, '/gmail/v1/users/me/messages/message%2F1');
  assert.equal(captured.url.searchParams.get('format'), 'full');
  assert.match(captured.url.searchParams.get('fields'), /^id,payload\(/);
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers.authorization, 'Bearer access-token');
  assert.equal(JSON.stringify(fields).includes('private@example.test'), false);
});

test('Gmail detail reader fails closed on oversized bodies and mismatched IDs', async () => {
  const hugeText = 'x'.repeat(512 * 1024 + 1);
  const provider = createGoogleGmailApiProvider({
    getAccessToken: async () => 'token',
    fetchImpl: async () => jsonResponse(200, {
      id: 'other-id',
      payload: {
        headers: [],
        mimeType: 'text/plain',
        body: { data: Buffer.from(hugeText).toString('base64url') }
      }
    }),
    maxRetries: 0
  });
  await assert.rejects(provider.getMessageForClassification('requested-id'), /invalid message/);
  const matchingProvider = createGoogleGmailApiProvider({
    getAccessToken: async () => 'token',
    fetchImpl: async () => jsonResponse(200, {
      id: 'requested-id',
      payload: {
        headers: [],
        mimeType: 'text/plain',
        body: { data: Buffer.from(hugeText).toString('base64url') }
      }
    }),
    maxRetries: 0
  });
  await assert.rejects(matchingProvider.getMessageForClassification('requested-id'), /classifier limit/);
});
