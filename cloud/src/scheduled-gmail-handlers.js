import { runGmailScanPage } from './gmail-scan-worker.js';

function timestamp(value, name) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} must be a valid timestamp`);
  return parsed;
}

/** Bind the fixed hourly and result-focus jobs to independent durable Gmail checkpoints. */
export function createScheduledGmailHandlers({
  provider,
  checkpointStore,
  ledger,
  processMessage,
  maxResults = 50,
  clock = () => Date.now()
} = {}) {
  if (!provider || typeof provider.listMessages !== 'function') throw new TypeError('a Gmail provider is required');
  if (!checkpointStore || typeof checkpointStore.load !== 'function') throw new TypeError('a Gmail checkpoint store is required');
  if (!ledger || typeof ledger.claim !== 'function') throw new TypeError('a durable message job ledger is required');
  if (typeof processMessage !== 'function') throw new TypeError('a Gmail message processor is required');
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new RangeError('maxResults must be from 1 to 50');

  async function run(job, scanType) {
    if (!job || typeof job.jobKey !== 'string' || typeof job.scheduledAt !== 'string') {
      throw new TypeError('a scheduled Gmail job is required');
    }
    if (scanType === 'hourly' && (job.kind !== 'gmail-lottery-inbox'
      || !job.jobKey.startsWith('gmail-lottery-inbox:'))) {
      throw new TypeError('an hourly Gmail job is required');
    }
    if (scanType === 'results' && (job.kind !== 'lottery-result-focus'
      || !job.jobKey.startsWith('lottery-result-focus:'))) {
      throw new TypeError('a lottery result-focus job is required');
    }
    const scanAt = scanType === 'results' && job.triggeredAt ? job.triggeredAt : job.scheduledAt;
    return runGmailScanPage({
      provider,
      checkpointStore,
      ledger,
      processMessage,
      scanType,
      nowMs: timestamp(scanAt, 'scheduled Gmail time'),
      maxResults,
      clock
    });
  }

  return {
    'gmail-lottery-inbox': (job) => run(job, 'hourly'),
    'lottery-result-focus': (job) => run(job, 'results')
  };
}
