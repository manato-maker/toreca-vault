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
  maxResults = 100,
  clock = () => Date.now()
} = {}) {
  if (!provider || typeof provider.listMessages !== 'function') throw new TypeError('a Gmail provider adapter is required');
  if (!checkpointStore || typeof checkpointStore.load !== 'function'
    || typeof checkpointStore.saveCursor !== 'function'
    || typeof checkpointStore.saveLastSuccessfulAt !== 'function') {
    throw new TypeError('a durable checkpoint store is required');
  }
  if (typeof processMessage !== 'function') throw new TypeError('a Gmail message processor is required');

  const saved = await checkpointStore.load(scanType) || {};
  const plan = planGmailScanPage({
    nowMs,
    lastSuccessfulAtMs: saved.lastSuccessfulAtMs ?? null,
    cursor: saved.cursor ?? null,
    scanType,
    maxResults
  });
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
    await checkpointStore.saveCursor(scanType, null);
    await checkpointStore.saveLastSuccessfulAt(scanType, advanced.lastSuccessfulAtMs);
  } else {
    await checkpointStore.saveCursor(scanType, advanced.cursor);
  }
  return { scanType, fetched: page.messages.length, planned: jobs.length, results, checkpoint: advanced };
}
