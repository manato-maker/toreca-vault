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
  assert.deepEqual(result, { kind: 'result', identity: { status: 'review', reasonCode: 'lottery-retailer-unknown' } });
  assert.equal(JSON.stringify(calls).includes('private'), false);
});

test('Gmail identity is returned transiently while the durable store receives no application ID', async () => {
  const stored = [];
  const processMessage = createGmailClassifierProcessor({
    provider: {
      async getMessageForClassification() {
        return {
          subject: 'カードボックス オーサカ店 ポケモンカード 抽選申込完了',
          text: 'お申し込み番号: CB-991'
        };
      }
    },
    classificationStore: { async record(_messageId, outcome) { stored.push(outcome); } }
  });
  const result = await processMessage({ messageId: 'message-id-2' });
  assert.equal(result.identity.status, 'ready');
  assert.deepEqual(result.identity.businessEventIdentity, {
    retailerKey: 'cardbox-osaka', applicationId: 'CB-991'
  });
  assert.deepEqual(stored, [{ kind: 'application' }]);
  assert.equal(JSON.stringify(stored).includes('CB-991'), false);
});

test('classifier processor validates dependencies and message identifiers', async () => {
  assert.throws(() => createGmailClassifierProcessor({ provider: {}, classificationStore: {} }), /detail provider/);
  const processMessage = createGmailClassifierProcessor({
    provider: { async getMessageForClassification() { return { subject: '', text: '' }; } },
    classificationStore: { async record() {} }
  });
  await assert.rejects(processMessage({ messageId: '' }), /messageId is invalid/);
});

test('classifier processor fails closed when command-draft identity differs from the resolved Gmail identity', async () => {
  let outboxInput;
  const processMessage = createGmailClassifierProcessor({
    provider: {
      async getMessageForClassification() {
        return { subject: 'ポケモンカード 抽選申込完了', text: '応募ID: APP-123\n店舗名: カードボックス日本橋店' };
      }
    },
    classificationStore: { async record() {} },
    resolveIdentity: () => ({ status: 'ready', businessEventIdentity: { retailerKey: 'cardbox-nihonbashi', applicationId: 'APP-123' } }),
    buildCommandDraft: () => ({
      command: { type: 'lottery', title: '商品A' },
      businessEventIdentity: { retailerKey: 'cardbox-osaka', applicationId: 'APP-123' }
    }),
    commandOutbox: {
      async record(input) {
        outboxInput = input;
        return { status: input.commandDraft ? 'submitted' : 'review', submitted: Boolean(input.commandDraft) };
      }
    }
  });
  const result = await processMessage({ messageId: 'mismatched-identity-mail' });
  assert.equal(result.identity.status, 'ready');
  assert.equal(result.queue.status, 'review');
  assert.equal(outboxInput.commandDraft, null);
  assert.equal(outboxInput.businessEventIdentity, null);
});
