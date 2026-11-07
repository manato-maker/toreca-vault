import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

const MAX_DOCUMENT_BYTES = 900_000;
const MAX_SEGMENT_BYTES = 650_000;
const MAX_TRANSACTION_PAYLOAD_BYTES = 7_000_000;
const MAX_SEGMENTS = 400;

function estimateChunks(key, items, revision) {
  const size = (index, values) => Buffer.byteLength(JSON.stringify({
    schemaVersion: 1, revision, key, index, items: values
  }), 'utf8');
  let count = 0;
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (size(count, candidate) <= MAX_SEGMENT_BYTES) {
      current = candidate;
    } else {
      if (!current.length || size(count, [item]) > MAX_SEGMENT_BYTES) return null;
      count += 1;
      current = [item];
    }
  }
  if (current.length) count += 1;
  return count;
}

function storagePlan(snapshot, documentBytes) {
  if (documentBytes <= MAX_DOCUMENT_BYTES) return { plan: 'single', segmentCount: 0 };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_TRANSACTION_PAYLOAD_BYTES) {
    return { plan: 'blocked', segmentCount: 0 };
  }

  const inline = {};
  const arrayChunkCounts = {};
  let segmentCount = 0;
  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      const count = estimateChunks(key, value, Number(snapshot.revision) || 0);
      if (count === null) return { plan: 'blocked', segmentCount: 0 };
      arrayChunkCounts[key] = count;
      segmentCount += count;
    } else {
      inline[key] = value;
    }
  }
  if (segmentCount > MAX_SEGMENTS) return { plan: 'blocked', segmentCount: 0 };
  const root = {
    schemaVersion: 2,
    storageFormat: 'chunked-v1',
    revision: Number(snapshot.revision) || 0,
    lastMutationId: snapshot.lastMutationId || '',
    inlinePayload: inline,
    payloadOrder: Object.keys(snapshot),
    arrayChunkCounts,
    segmentIds: Array.from({ length: segmentCount }, () => 'array_' + '0'.repeat(16) + '_0000'),
    payloadBytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    payloadHash: '0'.repeat(64)
  };
  if (Buffer.byteLength(JSON.stringify(root), 'utf8') > MAX_DOCUMENT_BYTES) {
    return { plan: 'blocked', segmentCount: 0 };
  }
  return { plan: 'chunked', segmentCount };
}

export function inspectV2Snapshot(snapshot, sourceBytes = null) {
  validateState(snapshot);
  const serialized = JSON.stringify(snapshot);
  const bytes = sourceBytes == null ? Buffer.from(serialized, 'utf8') : Buffer.from(sourceBytes);
  const transactionsByType = {};
  const knownTransactionTypes = new Set(['purchase', 'sale', 'opening']);
  for (const transaction of snapshot.transactions) {
    const rawType = String(transaction.type || '');
    const type = knownTransactionTypes.has(rawType) ? rawType : 'other';
    transactionsByType[type] = (transactionsByType[type] || 0) + 1;
  }

  const inventoryByCategoryCondition = {};
  for (const lot of snapshot.inventoryLots) {
    const key = String(lot.category || 'unknown') + ' / '
      + String(lot.condition || lot.shrinkStatus || 'unspecified');
    inventoryByCategoryCondition[key] = (inventoryByCategoryCondition[key] || 0) + Number(lot.quantity || 0);
  }

  const lotteryByStatus = {};
  const knownLotteryStatuses = new Set(['当選', '落選', '応募済', '受付中', '未確認', '結果待ち', '購入済', 'キャンセル']);
  for (const lottery of snapshot.lotteries) {
    const rawStatus = String(lottery.result || lottery.status || '');
    const status = knownLotteryStatuses.has(rawStatus) ? rawStatus : 'その他';
    lotteryByStatus[status] = (lotteryByStatus[status] || 0) + 1;
  }

  const estimate = Buffer.byteLength(JSON.stringify({ payload: snapshot }), 'utf8');
  const plan = storagePlan(snapshot, estimate);
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: Number(snapshot.revision) || 0,
    lastMutationIdPresent: Boolean(snapshot.lastMutationId),
    sourceBytes: bytes.length,
    firestoreDocumentBytesEstimate: estimate,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    firestoreStoragePlan: plan.plan,
    firestoreSegmentCountEstimate: plan.segmentCount,
    counts: {
      transactions: snapshot.transactions.length,
      transactionsByType,
      inventoryLots: snapshot.inventoryLots.length,
      inventoryQuantityByCategoryCondition: inventoryByCategoryCondition,
      lotteries: snapshot.lotteries.length,
      lotteriesByStatus: lotteryByStatus,
      marketQuotes: snapshot.marketQuotes.length,
      auditLogEntries: snapshot.auditLog.length
    },
    firestoreDocumentLimitBytes: 1_048_576,
    firestoreSingleDocumentSafetyLimitBytes: MAX_DOCUMENT_BYTES,
    firestoreSegmentDocumentSafetyLimitBytes: MAX_SEGMENT_BYTES,
    firestoreMaximumTransactionPayloadBytes: MAX_TRANSACTION_PAYLOAD_BYTES,
    firestoreSingleDocumentFitsSafetyLimit: estimate <= MAX_DOCUMENT_BYTES,
    firestoreSnapshotFitsSafetyLimit: plan.plan !== 'blocked',
    firestoreDocumentOperationsPerSuccessfulMutationEstimate: plan.plan === 'blocked' ? null : {
      reads: plan.plan === 'single' ? 3 : 3 + (2 * plan.segmentCount),
      writes: 1 + plan.segmentCount,
      deletes: null,
      basis: 'Baseline counts include the duplicate-check read, revision-CAS root read, and post-write readback; chunked reads include all segments. Writes include the root and new segments. Transaction retries and obsolete-segment cleanup deletes are excluded.'
    }
  };
}

