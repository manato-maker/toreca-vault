import { createHash } from 'node:crypto';
import { validateState } from '../../v2/core.js';

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
    const key = `${String(lot.category || 'unknown')} / ${String(lot.condition || lot.shrinkStatus || 'unspecified')}`;
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
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: Number(snapshot.revision) || 0,
    lastMutationIdPresent: Boolean(snapshot.lastMutationId),
    sourceBytes: bytes.length,
    firestoreDocumentBytesEstimate: estimate,
    sha256: createHash('sha256').update(bytes).digest('hex'),
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
    firestoreSafetyLimitBytes: 900_000,
    firestoreSnapshotFitsSafetyLimit: estimate <= 900_000
  };
}
