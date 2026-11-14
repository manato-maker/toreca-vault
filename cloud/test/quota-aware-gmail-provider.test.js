import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaAwareGmailProvider } from '../src/quota-aware-gmail-provider.js';

test('quota-aware provider retries transient quota responses with bounded delay', async () => {
  let calls = 0;
  const delays = [];
  const provider = createQuotaAwareGmailProvider({
    request: async (params) => {
      calls += 1;
      assert.deepEqual(params, { query: 'after:1 before:2 {lottery}', maxResults: 5, pageToken: 'p2' });
      if (calls < 3) {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      }
      return { messages: [{ id: 'm1' }] };
    },
    sleep: async (ms) => delays.push(ms),
    random: () => 0,
    now: () => 0,
    baseDelayMs: 100,
    maxDelayMs: 500
  });
  const result = await provider.listMessages('after:1 before:2 {lottery}', { maxResults: 5, pageToken: 'p2' });
  assert.deepEqual(result, { messages: [{ id: 'm1' }] });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);
});

test('quota-aware provider honors Retry-After but caps the delay', async () => {
  let calls = 0;
  const delays = [];
  const provider = createQuotaAwareGmailProvider({
    request: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('quota');
        error.status = 403;
        error.errors = [{ reason: 'userRateLimitExceeded' }];
        error.headers = { 'retry-after': '90' };
        throw error;
      }
      return { messages: [] };
    },
    sleep: async (ms) => delays.push(ms),
    now: () => 0,
    maxRetries: 1,
    maxDelayMs: 1000
  });
  await provider.listMessages('query', { maxResults: 1 });
  assert.deepEqual(delays, [1000]);
});

test('quota-aware provider does not retry auth failures or exceed retry limit', async () => {
  let calls = 0;
  const auth = createQuotaAwareGmailProvider({
    request: async () => {
      calls += 1;
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    },
    sleep: async () => assert.fail('auth failures must not be retried')
  });
  await assert.rejects(auth.listMessages('query', { maxResults: 1 }), { status: 401 });
  assert.equal(calls, 1);

  calls = 0;
  const exhausted = createQuotaAwareGmailProvider({
    request: async () => {
      calls += 1;
      const error = new Error('temporary');
      error.status = 503;
      throw error;
    },
    sleep: async () => {},
    maxRetries: 2
  });
  await assert.rejects(exhausted.listMessages('query', { maxResults: 1 }), { status: 503 });
  assert.equal(calls, 3);
});


test('quota-aware provider rejects pages above the per-user safety cap', async () => {
  const provider = createQuotaAwareGmailProvider({ request: async () => ({ messages: [] }) });
  await assert.rejects(provider.listMessages('query', { maxResults: 51 }), /maxResults/);
  assert.deepEqual(await provider.listMessages('query', { maxResults: 50 }), { messages: [] });
});
