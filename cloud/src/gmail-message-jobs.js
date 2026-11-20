import { createHash } from 'node:crypto';

const DEFAULT_PAGE_SIZE = 50;

/** Build message-level durable job keys without retaining email bodies or headers. */
export function planGmailMessageJobs(messages, { maxMessages = DEFAULT_PAGE_SIZE } = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
    throw new TypeError('maxMessages must be an integer from 1 to 100');
  }
  if (messages.length > maxMessages) throw new RangeError('Gmail page exceeds the configured maximum; fetch a bounded page');
  const seen = new Set();
  const jobs = [];
  for (const message of messages) {
    const messageId = String(message?.id || '').trim();
    if (!messageId || messageId.length > 512 || /[\u0000-\u001f\u007f]/.test(messageId)) {
      throw new TypeError('every Gmail message needs a valid provider message ID');
    }
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const idHash = createHash('sha256').update(messageId).digest('hex');
    jobs.push({ kind: 'gmail-message', jobKey: `gmail-message:${idHash}`, messageId });
  }
  return jobs;
}
