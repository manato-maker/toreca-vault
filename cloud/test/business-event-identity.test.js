import test from 'node:test';
import assert from 'node:assert/strict';
import { createLotteryBusinessEventKey } from '../src/business-event-identity.js';

test('normalizes retailer spelling and creates the same key across independent sources', () => {
  const chat = createLotteryBusinessEventKey({ kind: 'application', retailerKey: ' Store A ', applicationId: 'AB-123' });
  const gmail = createLotteryBusinessEventKey({ kind: 'application', retailerKey: 'store   a', applicationId: 'AB-123' });
  assert.deepEqual(chat, gmail);
  assert.match(chat.businessEventKey, /^lottery:v1:[a-f0-9]{64}$/);
});

test('separates different event kinds, retailers, and application IDs', () => {
  const baseline = createLotteryBusinessEventKey({ kind: 'application', retailerKey: 'store-a', applicationId: 'AB-123' }).businessEventKey;
  for (const identity of [
    { kind: 'result', retailerKey: 'store-a', applicationId: 'AB-123' },
    { kind: 'application', retailerKey: 'store-b', applicationId: 'AB-123' },
    { kind: 'application', retailerKey: 'store-a', applicationId: 'AB-124' }
  ]) assert.notEqual(createLotteryBusinessEventKey(identity).businessEventKey, baseline);
});

test('missing, oversized, or control-character identities route to review without a key', () => {
  for (const identity of [
    { kind: 'application', retailerKey: 'store-a' },
    { kind: 'result', retailerKey: 'store-a', applicationId: 'x'.repeat(201) },
    { kind: 'receipt', retailerKey: 'store-a', applicationId: 'bad\nkey' }
  ]) {
    assert.equal(createLotteryBusinessEventKey(identity).status, 'review');
    assert.equal('businessEventKey' in createLotteryBusinessEventKey(identity), false);
  }
});

test('rejects unsupported event kinds rather than guessing', () => {
  assert.throws(() => createLotteryBusinessEventKey({ kind: 'bulk', retailerKey: 'store-a', applicationId: 'AB-123' }), /event kind/);
});
