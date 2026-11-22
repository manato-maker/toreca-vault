import { createHash } from 'node:crypto';

const RECEIPT_RESULT = Object.freeze({
  'v2-applied': { status: 'v2-applied', resultCode: 'canonical-readback-verified', final: true },
  'duplicate-already-applied': { status: 'duplicate', resultCode: 'already-applied-verified', final: true },
  'readback-mismatch': { status: 'review', resultCode: 'readback-mismatch', final: true }
});
const REVIEW_CODES = new Set(['attempt-limit', 'command-invalid', 'command-rejected', 'canonical-not-initialized', 'retryable-error', 'revision-conflict', 'readback-mismatch']);

function finalReceipt(queueRow) {
  if (queueRow.status === 'done') return RECEIPT_RESULT[queueRow.resultCode] || { status: 'review', resultCode: 'unknown-worker-result', final: true };
  if (queueRow.status === 'review') {
    const code = String(queueRow.resultCode || '').toLowerCase();
    return { status: 'review', resultCode: REVIEW_CODES.has(code) ? code : 'queue-review', final: true };
  }
  return null;
}

/** Reconcile queue outcomes back to receipt cells only after a verified sheet readback. */
export function createGoogleSheetsIntakeStatusProcessor({ provider, queue, spreadsheetId, maxRowsPerRun = 20, now = Date.now } = {}) {
  if (!provider || typeof provider.writeReceipt !== 'function') throw new TypeError('a Google Sheets intake provider is required');
  if (!queue || typeof queue.listIntakeReceipts !== 'function'
    || typeof queue.inspectByRequestIdHash !== 'function' || typeof queue.setIntakeReceiptStatus !== 'function') {
    throw new TypeError('a receipt-aware command queue is required');
  }
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
    throw new TypeError('a dedicated intake spreadsheet ID is required');
  }
  const spreadsheetIdHash = createHash('sha256').update(spreadsheetId).digest('hex');
  if (!Number.isSafeInteger(maxRowsPerRun) || maxRowsPerRun < 1 || maxRowsPerRun > 50) throw new RangeError('maxRowsPerRun must be from 1 to 50');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  return async function processIntakeStatuses() {
    const refs = await queue.listIntakeReceipts({ limit: maxRowsPerRun });
    if (!Array.isArray(refs) || refs.length > maxRowsPerRun) throw new Error('command queue returned an invalid intake receipt page');
    const result = { checked: 0, finalized: 0, pending: 0 };
    for (const ref of refs) {
      if (!ref || typeof ref.requestId !== 'string' || !ref.requestId.trim()
        || typeof ref.requestIdHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.requestIdHash)
        || typeof ref.spreadsheetIdHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.spreadsheetIdHash)
        || ref.spreadsheetIdHash !== spreadsheetIdHash || ref.requestIdHash !== hashIntakeRequestId(ref.requestId)
        || !Number.isSafeInteger(ref.rowNumber) || ref.rowNumber < 2 || ref.rowNumber > 100_001) {
        throw new Error('command queue returned an invalid intake receipt reference');
      }
      const queueRow = await queue.inspectByRequestIdHash(ref.requestIdHash);
      if (!queueRow || queueRow.requestId !== ref.requestId) throw new Error('intake queue correlation did not match');
      result.checked++;
      if (queueRow.status === 'pending') { result.pending++; continue; }
      if (queueRow.status === 'processing') { result.pending++; continue; }
      const receipt = finalReceipt(queueRow);
      if (!receipt) { result.pending++; continue; }
      await provider.writeReceipt(ref.rowNumber, {
        status: receipt.status, resultCode: receipt.resultCode, acceptedRequestId: ref.requestId,
        processedAtMs: Number.isSafeInteger(queueRow.updatedAtMs) ? queueRow.updatedAtMs : now()
      });
      const marked = await queue.setIntakeReceiptStatus(ref.requestId, { state: 'final', now: now() });
      if (!marked.updated) throw new Error('final intake receipt could not be recorded');
      result.finalized++;
    }
    return result;
  };
}

export function hashIntakeRequestId(requestId) {
  if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('requestId is required');
  return createHash('sha256').update(requestId.trim()).digest('hex');
}
