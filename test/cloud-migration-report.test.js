import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyTransaction, emptyV2 } from '../v2/core.js';
import { inspectV2Snapshot } from '../cloud/src/migration-report.js';

function sampleSnapshot() {
  const state = applyTransaction(emptyV2(), {
    id: 'secret-transaction-id', type: 'purchase', product: 'Private Product Name',
    productKey: 'private-product-key', category: 'BOX', condition: 'あり',
    quantity: 2, unitCost: 100, date: '2026-11-03'
  }, 'secret-mutation-id');
  state.lotteries.push({ id: 'private-lottery-id', status: '応募済' });
  state.marketQuotes.push({ productKey: 'private-product-key', price: 999, source: 'private-source' });
  return state;
}

test('migration report validates V2 and emits only safe aggregates and source hash', () => {
  const snapshot = sampleSnapshot();
  const before = JSON.stringify(snapshot);
  const raw = Buffer.from(JSON.stringify(snapshot, null, 2) + '\\n', 'utf8');
  const report = inspectV2Snapshot(snapshot, raw);
  const text = JSON.stringify(report);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.revision, 1);
  assert.equal(report.sourceBytes, raw.length);
  assert.equal(report.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(report.firestoreStoragePlan, 'single');
  assert.equal(report.firestoreSnapshotFitsSafetyLimit, true);
  assert.deepEqual(report.firestoreDocumentOperationsPerSuccessfulMutationEstimate, {
    reads: 3, writes: 1, deletes: null,
    basis: 'Baseline counts include the duplicate-check read, revision-CAS root read, and post-write readback; chunked reads include all segments. Writes include the root and new segments. Transaction retries and obsolete-segment cleanup deletes are excluded.'
  });
  assert.equal(report.counts.transactionsByType.purchase, 1);
  assert.equal(report.counts.inventoryQuantityByCategoryCondition['BOX / あり'], 2);
  assert.equal(report.counts.lotteriesByStatus['応募済'], 1);
  assert.equal(report.counts.marketQuotes, 1);
  assert.equal(text.includes('Private Product Name'), false);
  assert.equal(text.includes('secret-transaction-id'), false);
  assert.equal(text.includes('secret-mutation-id'), false);
  assert.equal(JSON.stringify(snapshot), before);
});

test('migration report identifies chunkable snapshots above the single-document budget', () => {
  const snapshot = sampleSnapshot();
  snapshot.lotteries = Array.from({ length: 520 }, (_, index) => ({
    id: 'lottery-' + index, status: '応募済', memo: 'x'.repeat(1900)
  }));
  const report = inspectV2Snapshot(snapshot);
  assert.ok(report.firestoreDocumentBytesEstimate > report.firestoreSingleDocumentSafetyLimitBytes);
  assert.equal(report.firestoreStoragePlan, 'chunked');
  assert.equal(report.firestoreSingleDocumentFitsSafetyLimit, false);
  assert.equal(report.firestoreSnapshotFitsSafetyLimit, true);
  assert.ok(report.firestoreSegmentCountEstimate > 1);
  assert.equal(
    report.firestoreDocumentOperationsPerSuccessfulMutationEstimate.reads,
    3 + (2 * report.firestoreSegmentCountEstimate)
  );
  assert.equal(
    report.firestoreDocumentOperationsPerSuccessfulMutationEstimate.writes,
    1 + report.firestoreSegmentCountEstimate
  );
});

test('migration report fails closed when an atomic inline field cannot be chunked', () => {
  const snapshot = sampleSnapshot();
  snapshot.automation.diagnosticOnly = 'x'.repeat(900_001);
  const report = inspectV2Snapshot(snapshot);
  assert.equal(report.firestoreStoragePlan, 'blocked');
  assert.equal(report.firestoreSnapshotFitsSafetyLimit, false);
});

test('migration report rejects invalid V2 schema', () => {
  assert.throws(() => inspectV2Snapshot({ schemaVersion: 1 }), /schemaVersion=2/);
});

test('migration report reduces unknown transaction and lottery values to aggregate buckets', () => {
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

