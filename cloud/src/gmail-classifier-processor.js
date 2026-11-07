import { classifyLotteryMessage } from './gmail-classifier.js';

/** Fetch bounded transient fields and durably record only their compact classification. */
export function createGmailClassifierProcessor({
  provider,
  classificationStore,
  commandOutbox = null,
  buildCommandDraft = null,
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
  if (commandOutbox && typeof commandOutbox.record !== 'function') throw new TypeError('a Gmail command outbox is invalid');
  if (buildCommandDraft !== null && typeof buildCommandDraft !== 'function') throw new TypeError('buildCommandDraft must be a function');

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
    let queue = null;
    if (commandOutbox && ['application', 'result'].includes(classification.kind)) {
      const draft = buildCommandDraft ? await buildCommandDraft({ fields, classification }) : null;
      queue = await commandOutbox.record({ messageId, classification, commandDraft: draft?.command || null,
        businessEventIdentity: draft?.businessEventIdentity || null });
    }
    if (queue) return { ...classification, queue };
    return classification;
  };
}
