import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleSchedulerAuthorizer } from '../src/google-scheduler-authorizer.js';

const audience = 'https://toreca-vault-example.run.app';
const serviceAccountEmail = 'toreca-scheduler@example.iam.gserviceaccount.com';

function makeRequest(token = 'signed-id-token') {
  return { headers: { authorization: token ? `Bearer ${token}` : '' } };
}

test('Google Scheduler authorizer verifies token audience and exact service account identity', async () => {
  const calls = [];
  const authorize = createGoogleSchedulerAuthorizer({
    audience,
    serviceAccountEmail,
    verifier: {
      async verifyIdToken(input) {
        calls.push(input);
        return { getPayload: () => ({ aud: audience, email: serviceAccountEmail, email_verified: true }) };
      }
    }
  });
  assert.equal(await authorize(makeRequest()), true);
  assert.deepEqual(calls, [{ idToken: 'signed-id-token', audience }]);
});

test('Google Scheduler authorizer rejects missing tokens and identity/audience mismatches', async () => {
  const payloads = [
    { aud: 'https://other.run.app', email: serviceAccountEmail, email_verified: true },
    { aud: audience, email: 'other@example.iam.gserviceaccount.com', email_verified: true },
    { aud: audience, email: serviceAccountEmail, email_verified: false }
  ];
  const authorize = createGoogleSchedulerAuthorizer({
    audience,
    serviceAccountEmail,
    verifier: { async verifyIdToken() { return { getPayload: () => payloads.shift() }; } }
  });
  assert.equal(await authorize(makeRequest('')), false);
  assert.equal(await authorize(makeRequest()), false);
  assert.equal(await authorize(makeRequest()), false);
  assert.equal(await authorize(makeRequest()), false);
});

test('Google Scheduler authorizer fails closed when token verification fails', async () => {
  const authorize = createGoogleSchedulerAuthorizer({
    audience,
    serviceAccountEmail,
    verifier: { async verifyIdToken() { throw new Error('bad signature'); } }
  });
  assert.equal(await authorize(makeRequest()), false);
});

test('Google Scheduler authorizer validates configuration before serving requests', () => {
  const verifier = { verifyIdToken() {} };
  assert.throws(() => createGoogleSchedulerAuthorizer({ verifier, audience: 'http://localhost', serviceAccountEmail }), /HTTPS/);
  assert.throws(() => createGoogleSchedulerAuthorizer({ verifier, audience, serviceAccountEmail: 'bad-email' }), /email/);
});
