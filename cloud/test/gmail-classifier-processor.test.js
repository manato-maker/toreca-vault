import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';

test('classifier processor requests transient subject/body and returns only the classifier result', async () => {
  const calls = [];
  const provider = {
    async getMessageForClassification(messageId) {
      calls.push(messageId);
      return { subject: 'ポケモンカード 抽選結果', text: 'private body text' };
    }
  };
  const processMessage = createGmailClassifierProcessor({ provider });
  const result = await processMessage({ messageId: 'message-id-1', jobKey: 'gmail-message:hash' });
  assert.deepEqual(calls, ['message-id-1']);
  assert.deepEqual(result, { kind: 'result' });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('classifier processor validates provider and processor message identifiers', async () => {
  assert.throws(() => createGmailClassifierProcessor({ provider: {} }), /detail provider/);
  const processMessage = createGmailClassifierProcessor({
    provider: { async getMessageForClassification() { return { subject: '', text: '' }; } }
  });
  await assert.rejects(processMessage({ messageId: '' }), /messageId is invalid/);
});
