/**
 * Defense in depth: a dashboard request must carry a valid Google-signed
 * IAP assertion *and* belong to the explicit email allowlist.
 * Do not rely on unsigned x-goog-authenticated-user-email.
 */
export function createIapVerifier({
  audience,
  allowedEmails,
  oauthClient = null,
  now = () => Date.now()
}) {
  if (!/^\/projects\/[0-9]+\/locations\/[a-z0-9-]+\/services\/[a-z][a-z0-9-]*$/.test(audience || '')) {
    throw new Error('a Cloud Run IAP audience is required');
  }
  const emails = new Set(
    String(allowedEmails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  if (!emails.size) throw new Error('TV2_DASHBOARD_ALLOWED_EMAILS is required');

  let client = oauthClient;
  let publicKeys = null;
  let refreshAt = 0;
  return async function verifyIap(request) {
    const assertion = String(request.headers['x-goog-iap-jwt-assertion'] || '');
    if (!assertion || assertion.length > 8192) return false;
    try {
      const header = JSON.parse(Buffer.from(assertion.split('.')[0] || '', 'base64url').toString('utf8'));
      if (header.alg !== 'ES256') return false;
      if (!client) {
        const { OAuth2Client } = await import('google-auth-library');
        client = new OAuth2Client();
      }
      if (!publicKeys || now() >= refreshAt) {
        const response = await client.getIapPublicKeys();
        publicKeys = response.pubkeys;
        refreshAt = now() + 5 * 60 * 1000;
      }
      const ticket = await client.verifySignedJwtWithCertsAsync(
        assertion, publicKeys, audience, ['https://cloud.google.com/iap']
      );
      const payload = ticket.getPayload();
      return Boolean(payload?.sub && payload?.email && emails.has(String(payload.email).toLowerCase()));
    } catch {
      return false;
    }
  };
}
