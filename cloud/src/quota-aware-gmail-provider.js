const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_403_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);

function statusOf(error) {
  const value = Number(error?.status ?? error?.code ?? error?.response?.status);
  return Number.isFinite(value) ? value : null;
}

function reasonsOf(error) {
  const reasons = error?.errors ?? error?.response?.data?.error?.errors ?? [];
  if (!Array.isArray(reasons)) return [];
  return reasons.map((item) => String(item?.reason ?? ''));
}

function retryable(error) {
  const status = statusOf(error);
  if (RETRYABLE_STATUS.has(status)) return true;
  return status === 403 && reasonsOf(error).some((reason) => RETRYABLE_403_REASONS.has(reason));
}

function retryAfterMs(error, nowMs) {
  const headers = error?.response?.headers ?? error?.headers;
  let value;
  if (typeof headers?.get === 'function') value = headers.get('retry-after');
  else if (headers && typeof headers === 'object') {
    value = headers['retry-after'] ?? headers['Retry-After'];
  }
  if (value == null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(String(value));
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

/** Wrap an injected Gmail list request with bounded quota/transient retries. */
export function createQuotaAwareGmailProvider({
  request,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
  maxRetries = 4,
  baseDelayMs = 1000,
  maxDelayMs = 30_000
} = {}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  if (typeof sleep !== 'function' || typeof random !== 'function' || typeof now !== 'function') {
    throw new TypeError('sleep, random, and now must be functions');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new TypeError('maxRetries must be from 0 to 10');
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0
    || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new TypeError('retry delay bounds are invalid');
  }

  return {
    async listMessages(query, { maxResults, pageToken = null } = {}) {
      if (typeof query !== 'string' || !query) throw new TypeError('query is required');
      if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
        throw new TypeError('maxResults must be from 1 to 100');
      }
      if (pageToken != null && (typeof pageToken !== 'string' || pageToken.length > 2048)) {
        throw new TypeError('pageToken is invalid');
      }

      for (let retry = 0; ; retry += 1) {
        try {
          return await request({ query, maxResults, pageToken });
        } catch (error) {
          if (!retryable(error) || retry >= maxRetries) throw error;
          const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** retry));
          const serverDelay = retryAfterMs(error, now());
          const delay = Math.min(maxDelayMs, serverDelay ?? Math.floor(exponential * (0.5 + random())));
          await sleep(delay);
        }
      }
    }
  };
}
