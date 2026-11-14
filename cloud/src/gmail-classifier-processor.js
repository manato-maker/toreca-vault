import { classifyLotteryMessage } from './gmail-classifier.js';
import { resolveGmailLotteryIdentity } from './lottery-event-intake.js';

/** Fetch bounded transient fields and durably record only their compact classification. */
export function createGmailClassifierProcessor({
  provider,
  classificationStore,
  commandOutbox = null,
  buildCommandDraft = null,
  classify = classifyLotteryMessage,
  resolveIdentity = resolveGmailLotteryIdentity,
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
    // The raw ID and derived key stay transient. The durable classifier store
    // intentionally receives only the allowlisted kind/reason outcome.
    await classificationStore.record(messageId, classification);
    if (classification.kind !== 'application' && classification.kind !== 'result') return classification;
    const eventKind = classification.kind === 'application' ? 'application' : 'result';
    const identity = resolveIdentity({ kind: eventKind, subject: fields.subject, text: fields.text });
    let queue = null;
    if (commandOutbox) {
      const draft = buildCommandDraft ? await buildCommandDraft({ fields, classification, identity }) : null;
      const draftIdentity = draft?.businessEventIdentity;
      const identityMatches = identity?.status === 'ready'
        && draftIdentity?.retailerKey === identity.businessEventIdentity?.retailerKey
        && draftIdentity?.applicationId === identity.businessEventIdentity?.applicationId;
      queue = await commandOutbox.record({
        messageId,
        classification,
        commandDraft: identityMatches ? draft.command : null,
        businessEventIdentity: identityMatches ? draftIdentity : null
      });
    }
    return { ...classification, identity, ...(queue ? { queue } : {}) };
  };
}
