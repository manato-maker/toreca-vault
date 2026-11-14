/**
 * Never log raw worker errors, exception messages, API responses, URLs,
 * Authorization headers, spreadsheet content, Firestore paths, or PII.
 * These codes are a closed vocabulary for private operational logs.
 */
const SAFE_STAGES = new Set(['intake', 'reconciliation', 'authorization', 'unknown']);
const ERROR_REASONS = Object.freeze({
  'sheets-auth': /(?:Google Sheets access token is unavailable|Could not load the default credentials|Unable to detect a Project Id|invalid_grant|Could not refresh access token)/i,
  'sheets-permission': /Google Sheets[^]*?(?:HTTP 401|HTTP 403)/i,
  'sheets-not-found': /Google Sheets[^]*?HTTP 404/i,
  'sheets-rate-limit': /Google Sheets[^]*?HTTP 429/i,
  'sheets-upstream': /Google Sheets[^]*?HTTP 5\d\d/i,
  'sheets-wrong-target': /(?:configured spreadsheet is not the dedicated new-app intake sheet|Google Sheets intake header does not match the dedicated schema)/i,
  'sheets-response': /(?:Google Sheets returned invalid JSON|Google Sheets returned a malformed row|Google Sheets returned more rows than requested|Google Sheets response is too large)/i,
  'sheets-receipt-conflict': /(?:intake row request ID changed before receipt write|intake receipt transition would overwrite|intake receipt changed since finalization|intake receipt readback did not match)/i,
  'intake-cursor': /(?:Google Sheets intake cursor is invalid|stored Sheets intake cursor|nextRow must advance the cursor)/i,
  'intake-correlated-queue': /(?:invalid intake receipt reference|intake queue correlation did not match|final intake receipt could not be recorded)/i,
  'firestore-permission': /(?:PERMISSION_DENIED|Missing or insufficient permissions|7 PERMISSION_DENIED)/i,
  'firestore-index': /(?:FAILED_PRECONDITION|requires an index|The query requires an index)/i,
  'google-api-timeout': /(?:AbortError|TimeoutError|The operation was aborted|deadline exceeded)/i
});

/** Always return a fixed safe stage and reason; do not return exception strings. */
export function classifyIntakeFailure(stage, error) {
  const safeStage = SAFE_STAGES.has(stage) ? stage : 'unknown';
  const candidate = [error, error?.cause].find(x => x && typeof x === 'object');
  const name = String(candidate?.name || '').slice(0, 80);
  const cause = error?.cause && typeof error.cause === 'object' ? error.cause : null;
  const message = [error?.message, cause?.message].filter(x => typeof x === 'string').join(' ');
  for (const [reasonCode, pattern] of Object.entries(ERROR_REASONS)) {
    if (pattern.test(message) || (reasonCode === 'google-api-timeout' && /^(?:AbortError|TimeoutError)$/.test(name))) {
      return { stage: safeStage, reasonCode };
    }
  }
  return { stage: safeStage, reasonCode: 'unclassified' };
}

/** Emits ONLY a fixed event and two whitelisted tokens. */
export function logIntakeFailure(logger, stage, error) {
  const diagnostic = classifyIntakeFailure(stage, error);
  logger(JSON.stringify({ event: 'toreca-vault-intake-failure', ...diagnostic }));
  return diagnostic;
}
