import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailClassifierProcessor } from '../src/gmail-classifier-processor.js';

test('classifier processor stores only the compact outcome after transient message classification', async () => {
  const calls = [];
  const provider = {
    async getMessageForClassification(messageId) {
      calls.push(['read', messageId]);
      return { subject: 'ポケモンカード 抽選結果', text: 'private body text' };
    }
  };
  const classificationStore = {
    async record(messageId, result) {
      calls.push(['record', messageId, result]);
    }
  };
  const processMessage = createGmailClassifierProcessor({ provider, classificationStore });
  const result = await processMessage({ messageId: 'message-id-1', jobKey: 'gmail-message:hash' });
  assert.deepEqual(calls, [
    ['read', 'message-id-1'],
    ['record', 'message-id-1', { kind: 'result' }]
  ]);
  assert.deepEqual(result, { kind: 'result' });
  assert.equal(JSON.stringify(calls).includes('private'), false);
});

test('classifier processor validates dependencies and message identifiers', async () => {
  assert.throws(() => createGmailClassifierProcessor({ provider: {}, classificationStore: {} }), /detail provider/);
  const processMessage = createGmailClassifierProcessor({
    provider: { async getMessageForClassification() { return { subject: '', text: '' }; } },
    classificationStore: { async record() {} }
  });
  await assert.rejects(processMessage({ messageId: '' }), /messageId is invalid/);
});
