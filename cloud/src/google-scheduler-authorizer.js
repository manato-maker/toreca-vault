const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createGoogleSchedulerAuthorizer({ verifier, audience, serviceAccountEmail } = {}) {
  if (!verifier || typeof verifier.verifyIdToken !== 'function') {
    throw new TypeError('Google ID token verifier is required');
  }
  if (typeof audience !== 'string' || !audience.startsWith('https://')) {
    throw new TypeError('an HTTPS Scheduler audience is required');
  }
  if (typeof serviceAccountEmail !== 'string' || !EMAIL_PATTERN.test(serviceAccountEmail)) {
    throw new TypeError('a Scheduler service account email is required');
  }

  return async function authorizeGoogleSchedulerRequest(request) {
    const header = String(request?.headers?.authorization || '');
    const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!idToken) return false;
    try {
      const ticket = await verifier.verifyIdToken({ idToken, audience });
      const payload = ticket?.getPayload?.();
      return payload?.aud === audience
        && payload?.email === serviceAccountEmail
        && payload?.email_verified === true;
    } catch {
      return false;
    }
  };
}
