import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyTransaction, emptyV2 } from '../v2/core.js';
import { inspectV2Snapshot } from '../cloud/src/migration-report.js';

function sampleSnapshot() {
  let state = applyTransaction(emptyV2(), {
    id: 'secret-transaction-id',
    type: 'purchase',
    product: 'Private Product Name',
    productKey: 'private-product-key',
    category: 'BOX',
    condition: 'あり',
    quantity: 2,
    unitCost: 100,
    date: '2026-11-03'
  }, 'secret-mutation-id');
  state.lotteries.push({ id: 'private-lottery-id', status: '応募済' });
  state.marketQuotes.push({ productKey: 'private-product-key', price: 999, source: 'private-source' });
  return state;
}

test('migration report validates and summarizes V2 counts without emitting record identities', () => {
  const snapshot = sampleSnapshot();
  const before = JSON.stringify(snapshot);
  const raw = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const report = inspectV2Snapshot(snapshot, raw);
  const text = JSON.stringify(report);

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.revision, 1);
  assert.equal(report.sourceBytes, raw.length);
  assert.equal(report.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(report.counts.transactionsByType.purchase, 1);
  assert.equal(report.counts.inventoryQuantityByCategoryCondition['BOX / あり'], 2);
  assert.equal(report.counts.lotteriesByStatus['応募済'], 1);
  assert.equal(report.counts.marketQuotes, 1);
  assert.equal(text.includes('Private Product Name'), false);
  assert.equal(text.includes('secret-transaction-id'), false);
  assert.equal(text.includes('secret-mutation-id'), false);
  assert.equal(JSON.stringify(snapshot), before);
});

test('migration report identifies snapshots above its Firestore safety budget', () => {
  const snapshot = sampleSnapshot();
  snapshot.automation.diagnosticOnly = 'x'.repeat(900_001);
  const report = inspectV2Snapshot(snapshot);
  assert.equal(report.firestoreSnapshotFitsSafetyLimit, false);
  assert.ok(report.firestoreDocumentBytesEstimate > report.firestoreSafetyLimitBytes);
});

test('migration report rejects an invalid V2 schema', () => {
  assert.throws(() => inspectV2Snapshot({ schemaVersion: 1 }), /schemaVersion=2/);
});

test('migration report reduces unrecognized transaction and lottery fields to safe aggregate buckets', () => {
  const snapshot = sampleSnapshot();
  snapshot.lotteries[0].status = 'owner@example.test';
  snapshot.transactions[0].type = 'customer-name@example.test';
  const report = inspectV2Snapshot(snapshot);
  const text = JSON.stringify(report);
  assert.equal(report.counts.transactionsByType.other, 1);
  assert.equal(report.counts.lotteriesByStatus['その他'], 1);
  assert.equal(text.includes('owner@example.test'), false);
  assert.equal(text.includes('customer-name@example.test'), false);
});
