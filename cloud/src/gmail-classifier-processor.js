import { classifyLotteryMessage } from './gmail-classifier.js';

/** Fetch bounded transient fields and durably record only their compact classification. */
export function createGmailClassifierProcessor({
  provider,
  classificationStore,
  classify = classifyLotteryMessage,
  resultOnly = false
} = {}) {
  if (!provider || typeof provider.getMessageForClassification !== 'function') {
    throw new TypeError('a Gmail detail provider is required');
  }
  if (!classificationStore || typeof classificationStore.record !== 'function') {
    throw new TypeError('a durable Gmail classification store is required');
  }
  if (typeof classify !== 'function') throw new TypeError('a message classifier is required');

  return async function processGmailMessage({ messageId } = {}) {
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 512) {
      throw new TypeError('messageId is invalid');
    }
    const fields = await provider.getMessageForClassification(messageId);
    if (!fields || typeof fields !== 'object') throw new TypeError('Gmail provider returned invalid classifier fields');
    const classification = classify({
      subject: typeof fields.subject === 'string' ? fields.subject : '',
      text: typeof fields.text === 'string' ? fields.text : '',
      resultOnly
    });
    if (!classification || typeof classification.kind !== 'string') {
      throw new TypeError('message classifier returned an invalid result');
    }
    await classificationStore.record(messageId, classification);
    return classification;
  };
}
