import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyV2 } from '../../v2/core.js';
import { preflight } from '../scripts/preflight-chat-staging.js';

const canonical = {
  payload: emptyV2(), revision: 8, lastMutationId: 'verified'
};
const metadata = {
  properties: { title: 'Toreca Vault New App Intake' },
  sheets: [{ properties: { title: 'Intake' } }]
};
const stubs = (overrides = {}) => ({
  createStore: async () => ({
    async read() { return canonical; },
    async save() { throw new Error('read-only probe must never write'); }
  }),
  createClient: async () => ({}),
  readSheet: async (_client, path) => path.includes('?fields=')
    ? metadata : { values: [['queued'], ['review'], ['v2-applied']] },
  output: () => {},
  ...overrides
});

test('readiness probe validates canonical and counts receipts without modifying data', async () => {
  const logs = [];
  const result = await preflight(stubs({ output: s => logs.push(s) }));
  assert.equal(result.canonical, true);
  assert.equal(result.sheet, true);
  assert.equal(result.revision, 8);
  assert.equal(result.warnings.length, 2);
  assert.ok(logs.some(x => x.includes('Intake receipt queued: 1')));
  assert.ok(logs.some(x => x.includes('Intake receipt review: 1')));
  assert.ok(logs.every(x => !x.includes('secret')));
});

test('readiness probe blocks missing canonical and wrong intake sheet', async () => {
  await assert.rejects(preflight(stubs({
    createStore: async () => ({ async read() { return null; } })
  })), /canonical is absent/);
  await assert.rejects(preflight(stubs({
    readSheet: async (_client, path) => path.includes('?fields=')
      ? { properties: { title: 'Wrong' }, sheets: [] }
      : { values: [] }
  })), /metadata does not match/);
});

test('readiness probe does not infer a zero-cost result when there are no queued records', async () => {
  const res = await preflight(stubs({
    readSheet: async (_client, path) => path.includes('?fields=')
      ? metadata : { values: [['v2-applied']] }
  }));
  assert.equal(res.canonical, true);
  assert.equal(res.sheet, true);
  assert.equal(res.warnings.length, 0);
  assert.equal('billingGuaranteedFree' in res, false);
});
