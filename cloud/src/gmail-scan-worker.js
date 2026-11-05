import { advanceGmailScanPage, planGmailScanPage } from './gmail-scan-planner.js';
import { planGmailMessageJobs } from './gmail-message-jobs.js';
import { dispatchJobs } from './worker-dispatcher.js';

/** Execute one bounded provider page. Cursor persistence follows durable message-job completion. */
export async function runGmailScanPage({
  provider,
  checkpointStore,
  ledger,
  processMessage,
  scanType = 'hourly',
  nowMs = Date.now(),
  maxResults = 50,
  clock = () => Date.now()
} = {}) {
  if (!provider || typeof provider.listMessages !== 'function') throw new TypeError('a Gmail provider adapter is required');
  if (!checkpointStore || typeof checkpointStore.load !== 'function'
    || typeof checkpointStore.saveCursor !== 'function'
    || typeof checkpointStore.completeScan !== 'function') {
    throw new TypeError('a durable checkpoint store is required');
  }
  if (typeof processMessage !== 'function') throw new TypeError('a Gmail message processor is required');

  const saved = await checkpointStore.load(scanType) || {};
  const expectedLastSuccessfulAtMs = saved.lastSuccessfulAtMs ?? null;
  const plan = planGmailScanPage({
    nowMs,
    lastSuccessfulAtMs: saved.lastSuccessfulAtMs ?? null,
    cursor: saved.cursor ?? null,
    scanType,
    maxResults
  });

  // Persist the fixed scan window before the external request. A crash or quota
  // failure then resumes the same bounded window instead of silently moving it.
  if (saved.cursor == null) {
    await checkpointStore.saveCursor(scanType, plan.cursor, {
      expectedCursor: null,
      expectedLastSuccessfulAtMs
    });
  }

  const page = await provider.listMessages(plan.query, {
    maxResults: plan.maxResults,
    pageToken: plan.pageToken
  });
  if (!page || !Array.isArray(page.messages) || page.messages.length > plan.maxResults) {
    throw new TypeError('Gmail provider returned an invalid or oversized page');
  }
  const jobs = planGmailMessageJobs(page.messages, { maxMessages: plan.maxResults });
  const results = await dispatchJobs(jobs, {
    ledger,
    handlers: { 'gmail-message': processMessage },
    clock
  });
  const incomplete = results.find((result) => !['completed', 'completed-duplicate'].includes(result.status));
  if (incomplete) {
    const error = new Error('Gmail page has uncompleted message jobs');
    error.name = 'GmailPageIncomplete';
    throw error;
  }

  const advanced = advanceGmailScanPage(plan.cursor, { nextPageToken: page.nextPageToken ?? null });
  if (advanced.complete) {
    await checkpointStore.completeScan(scanType, advanced.lastSuccessfulAtMs, {
      expectedCursor: plan.cursor,
      expectedLastSuccessfulAtMs
    });
  } else {
    await checkpointStore.saveCursor(scanType, advanced.cursor, {
      expectedCursor: plan.cursor,
      expectedLastSuccessfulAtMs
    });
  }
  return { scanType, fetched: page.messages.length, planned: jobs.length, results, checkpoint: advanced };
}
