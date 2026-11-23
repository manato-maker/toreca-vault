import { applyChatCommand } from './v2-command.js';
import { parseGoogleSheetsIntakeRow } from './google-sheets-intake.js';

const norm = (s) => String(s || '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '');
function fail(message) { throw new Error('scoped-opening-repair: ' + message); }
function validatedRow(row, statuses) {
  const status = String(row?.values?.[3] || '').trim();
  if (!statuses.includes(status)) fail('unexpected original Intake row status');
  return parseGoogleSheetsIntakeRow(row).command;
}

/**
 * Private-data-only reconciliation: the caller supplies the EXISTING original
 * opening Intake row, the verified purchase Intake rows and a canonical read.
 * No new request ID, Sheet row, source mutation or network access is created.
 */
export function planScopedBoxOpeningRepair({ canonical, openingRow, purchaseRows, excludedRequestIds = [] } = {}) {
  if (!canonical || !canonical.payload || !Number.isSafeInteger(canonical.revision)
    || canonical.revision < 0 || canonical.payload.revision !== canonical.revision) {
    fail('staging canonical revision mismatch');
  }
  if (!Array.isArray(purchaseRows) || purchaseRows.length < 1 || purchaseRows.length > 20
    || !Array.isArray(excludedRequestIds)) fail('invalid purchase evidence');
  const opening = validatedRow(openingRow, ['new', 'queued', 'v2-applied']);
  if (opening.type !== 'open-box' || !opening.product
    || !Number.isSafeInteger(opening.quantity) || opening.quantity !== purchaseRows.length) {
    fail('opening quantity or command type differs from source evidence');
  }
  const openingMemo = norm(opening.memo);
  const seen = new Set();
  const sources = [];
  for (const row of purchaseRows) {
    const purchase = validatedRow(row, ['v2-applied']);
    if (purchase.type !== 'purchase' || purchase.category !== 'BOX'
      || !purchase.requestId || seen.has(purchase.requestId)
      || excludedRequestIds.includes(purchase.requestId)
      || norm(purchase.product) !== norm(opening.product)
      || !purchase.store || !openingMemo.includes(norm(purchase.store))
      || purchase.date !== opening.date || purchase.quantity !== 1
      || !Number.isSafeInteger(purchase.unitCost) || purchase.unitCost < 0) {
      fail('purchase row does not match the original reported opening');
    }
    seen.add(purchase.requestId);
    const lotId = `chat-purchase-${purchase.requestId}-lot`;
    const lot = canonical.payload.inventoryLots.find((entry) => String(entry.id || '') === lotId);
    const transaction = canonical.payload.transactions.find((entry) => String(entry.id || '') === `chat-purchase-${purchase.requestId}`);
    if (!lot || !transaction || lot.requestId !== purchase.requestId || lot.category !== 'BOX'
      || norm(lot.productKey || lot.product) !== norm(opening.product)
      || String(lot.store || '') !== purchase.store
      || String(lot.acquiredAt || '') !== purchase.date
      || Number(lot.unitCost) !== purchase.unitCost || Number(lot.quantity) !== 1
      || String(lot.sourceTransactionId || '') !== transaction.id
      || transaction.type !== 'purchase' || transaction.requestId !== purchase.requestId
      || String(transaction.store || '') !== purchase.store
      || String(transaction.date || '') !== purchase.date
      || Number(transaction.price) !== purchase.unitCost
      || Number(transaction.quantity) !== 1) {
      fail('canonical purchase and matching stock lot are not uniquely verified');
    }
    sources.push({ lotId, purchaseRequestId: purchase.requestId, store: purchase.store,
      acquiredAt: purchase.date, unitCost: purchase.unitCost, quantity: 1 });
  }
  if (new Set(sources.map(source => source.lotId)).size !== purchaseRows.length) fail('duplicate source lot');
  const expectedCost = sources.reduce((sum, source) => sum + source.unitCost, 0);
  const command = { ...opening, expectedRevision: canonical.revision, sourceLots: sources };
  const planned = applyChatCommand(canonical.payload, command);
  if (planned.duplicate || planned.state.revision !== canonical.revision + 1) {
    fail('original opening request was already applied or revision changed');
  }
  const id = `chat-opening-${opening.requestId}`;
  const transaction = planned.state.transactions.find(tx => tx.id === id);
  if (!transaction || transaction.quantity !== opening.quantity
    || transaction.acquisitionCost !== expectedCost
    || !sources.every(source => !planned.state.inventoryLots.some(lot => lot.id === source.lotId))
    || sources.some(source => !planned.state.transactions.some(tx => tx.id === `chat-purchase-${source.purchaseRequestId}`))) {
    fail('planned opening effects failed read-only verification');
  }
  return { expectedRevision: canonical.revision, mutationId: planned.mutationId,
    openingRequestId: opening.requestId, transactionId: id, quantity: opening.quantity,
    expectedCost, sourceLots: sources, payload: planned.state };
}

/**
 * Save only a validated plan. The Firestore adapter enforces revision CAS and
 * post-write readback. A failed readback is not reported as success.
 */
export async function applyScopedBoxOpeningRepair({ store, plan } = {}) {
  if (!store || typeof store.save !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('canonical store is required');
  }
  if (!plan || !Number.isSafeInteger(plan.expectedRevision) || !Array.isArray(plan.sourceLots)
    || !plan.sourceLots.length || !plan.mutationId || !plan.payload) {
    throw new TypeError('verified scoped repair plan is required');
  }
  // Refuse a stale plan even before the Firestore CAS. The CAS remains decisive.
  const before = await store.read();
  if (!before || before.revision !== plan.expectedRevision) fail('canonical revision changed before save');
  const openedIds = new Set(plan.sourceLots.map(source => source.lotId));
  const previousUnrelatedLots = before.payload.inventoryLots.filter(lot => !openedIds.has(lot.id));
  const previousPurchaseRows = plan.sourceLots.map(source => before.payload.transactions.find(tx => tx.id === `chat-purchase-${source.purchaseRequestId}`));
  if (previousPurchaseRows.some(row => !row)) fail('original purchase history missing at save time');
  const written = await store.save({
    expectedRevision: plan.expectedRevision,
    mutationId: plan.mutationId,
    payload: plan.payload
  });
  if (written.duplicate) fail('repair was already applied concurrently; reconcile separately');
  const after = await store.read();
  if (!after || after.revision !== plan.expectedRevision + 1
    || after.lastMutationId !== plan.mutationId
    || !after.payload.transactions.some(tx => tx.id === plan.transactionId
      && tx.quantity === plan.quantity && tx.acquisitionCost === plan.expectedCost
      && JSON.stringify(tx.sourceLotIds) === JSON.stringify(plan.sourceLots.map(l => l.lotId)))
    || plan.sourceLots.some(source => after.payload.inventoryLots.some(lot => lot.id === source.lotId))) {
    fail('post-write canonical opening readback did not match');
  }
  const nextUnrelatedLots = after.payload.inventoryLots.filter(lot => !openedIds.has(lot.id));
  const nextPurchaseRows = plan.sourceLots.map(source => after.payload.transactions.find(tx => tx.id === `chat-purchase-${source.purchaseRequestId}`));
  if (JSON.stringify(nextUnrelatedLots) !== JSON.stringify(previousUnrelatedLots)
    || JSON.stringify(nextPurchaseRows) !== JSON.stringify(previousPurchaseRows)) {
    fail('unrelated inventory or original purchase cost changed during repair');
  }
  return { status: 'canonical-readback-verified', revision: after.revision,
    quantity: plan.quantity };
}
