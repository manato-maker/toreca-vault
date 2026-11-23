import { applyChatCommand } from './v2-command.js';
import { parseGoogleSheetsIntakeRow } from './google-sheets-intake.js';
import { validateState } from '../../v2/core.js';

const norm = (s) => String(s || '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '');
function fail(message) { throw new Error('scoped-opening-repair: ' + message); }
function validatedRow(row, statuses) {
  const status = String(row?.values?.[3] || '').trim();
  if (!statuses.includes(status)) fail('unexpected original Intake row status');
  return parseGoogleSheetsIntakeRow(row).command;
}

/** Fail-closed reconstruction of a same-day sale allocated by historic FIFO to
 *  the wrong source lot. No mutation is persisted at this stage. */
function correctHistoricalSaleProvenance({ canonical, sourceRows, missingSource, opening,
  excludedPurchaseRow, excludedSaleRow }) {
  if (!excludedPurchaseRow || !excludedSaleRow || sourceRows.length !== 2 || !missingSource) {
    fail('source-lot discrepancy requires excluded purchase and sale evidence');
  }
  const excludedPurchase = validatedRow(excludedPurchaseRow, ['v2-applied']);
  const excludedSale = validatedRow(excludedSaleRow, ['v2-applied']);
  if (excludedPurchase.type !== 'purchase' || excludedPurchase.category !== 'BOX'
    || excludedPurchase.quantity !== 1 || !excludedPurchase.requestId
    || excludedSale.type !== 'sale' || excludedSale.category !== 'BOX'
    || excludedSale.quantity !== 1 || excludedSale.date !== opening.date
    || excludedPurchase.date !== opening.date
    || norm(excludedSale.product) !== norm(opening.product)
    || norm(excludedPurchase.product) !== norm(opening.product)
    || excludedPurchase.unitCost !== missingSource.unitCost
    || !String(excludedSale.memo || '').toLowerCase().includes('mint')) {
    fail('excluded sold source is not uniquely evidenced');
  }
  const mintLotId = `chat-purchase-${excludedPurchase.requestId}-lot`;
  const remainingMint = canonical.payload.inventoryLots.filter(lot => String(lot.id) === mintLotId);
  const missingLotId = `chat-purchase-${missingSource.requestId}-lot`;
  const missingPurchaseTx = canonical.payload.transactions.find(tx => tx.id === `chat-purchase-${missingSource.requestId}`);
  const mintPurchaseTx = canonical.payload.transactions.find(tx => tx.id === `chat-purchase-${excludedPurchase.requestId}`);
  const saleId = `chat-sale-${excludedSale.requestId}`;
  const saleTx = canonical.payload.transactions.find(tx => tx.id === saleId);
  if (remainingMint.length !== 1 || remainingMint[0].quantity !== 1
    || String(remainingMint[0].requestId) !== excludedPurchase.requestId
    || String(remainingMint[0].store) !== excludedPurchase.store
    || String(remainingMint[0].acquiredAt) !== excludedPurchase.date
    || Number(remainingMint[0].unitCost) !== excludedPurchase.unitCost
    || String(remainingMint[0].sourceTransactionId) !== mintPurchaseTx?.id
    || remainingMint[0].category !== 'BOX'
    || norm(remainingMint[0].productKey || remainingMint[0].product) !== norm(opening.product)
    || !missingPurchaseTx || missingPurchaseTx.type !== 'purchase'
    || !mintPurchaseTx || mintPurchaseTx.type !== 'purchase'
    || Number(missingPurchaseTx.price) !== missingSource.unitCost
    || String(missingPurchaseTx.requestId) !== missingSource.requestId
    || String(missingPurchaseTx.store) !== missingSource.store
    || String(missingPurchaseTx.date) !== missingSource.date
    || String(missingPurchaseTx.category) !== 'BOX'
    || norm(missingPurchaseTx.productKey || missingPurchaseTx.product) !== norm(opening.product)
    || Number(mintPurchaseTx.price) !== excludedPurchase.unitCost
    || String(mintPurchaseTx.store) !== excludedPurchase.store
    || String(mintPurchaseTx.date) !== excludedPurchase.date
    || !saleTx || saleTx.type !== 'sale' || saleTx.requestId !== excludedSale.requestId
    || saleTx.category !== 'BOX'
    || saleTx.date !== excludedSale.date || saleTx.store !== excludedSale.store
    || Number(saleTx.quantity) !== 1 || Number(saleTx.price) !== excludedSale.unitPrice
    || Number(saleTx.acquisitionCost) !== excludedPurchase.unitCost
    || norm(saleTx.productKey || saleTx.product) !== norm(opening.product)) {
    fail('historical sale or remaining purchased lot mismatches canonical');
  }
  const competingTransactions = canonical.payload.transactions.filter(tx =>
    tx.type !== 'purchase' && tx.id !== saleId
    && ['sale', 'opening'].includes(tx.type)
    && tx.date >= opening.date
    && norm(tx.productKey || tx.product) === norm(opening.product));
  if (competingTransactions.length) fail('another same-product consumption requires manual provenance review');
  const virtual = structuredClone(canonical.payload);
  virtual.inventoryLots = virtual.inventoryLots.filter(lot => String(lot.id) !== mintLotId);
  virtual.inventoryLots.push({
    id: missingLotId, product: missingSource.product,
    productKey: missingSource.product, category: 'BOX',
    condition: String(missingPurchaseTx.condition || ''),
    set: '', quantity: 1, unitCost: missingSource.unitCost,
    acquiredAt: missingSource.date, store: missingSource.store,
    source: String(missingPurchaseTx.source || 'chat'),
    sourceTransactionId: missingPurchaseTx.id,
    requestId: missingSource.requestId,
    memo: String(missingPurchaseTx.memo || '')
  });
  const correctingSale = virtual.transactions.find(tx => tx.id === saleId);
  correctingSale.sourcePurchaseRequestId = excludedPurchase.requestId;
  correctingSale.provenanceCorrectedByRequestId = opening.requestId;
  validateState(virtual);
  return { payload: virtual, correction: {
    reassignedFromLotId: mintLotId,
    replacedMissingLotId: missingLotId,
    saleTransactionId: saleId,
    sourcePurchaseRequestId: excludedPurchase.requestId
  } };
}

/**
 * Private-data-only reconciliation: the caller supplies the EXISTING original
 * opening Intake row, the verified purchase Intake rows and a canonical read.
 * No new request ID, Sheet row, source mutation or network access is created.
 */
export function planScopedBoxOpeningRepair({ canonical, openingRow, purchaseRows, excludedRequestIds = [], excludedPurchaseRow, excludedSaleRow } = {}) {
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
  const missingSources = [];
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
    if (!transaction || transaction.type !== 'purchase'
      || transaction.requestId !== purchase.requestId
      || transaction.category !== 'BOX'
      || norm(transaction.productKey || transaction.product) !== norm(opening.product)
      || String(transaction.store || '') !== purchase.store
      || String(transaction.date || '') !== purchase.date
      || Number(transaction.price) !== purchase.unitCost
      || Number(transaction.quantity) !== 1) {
      fail('canonical purchase history mismatches original Intake');
    }
    if (!lot) missingSources.push(purchase);
    else if (lot.requestId !== purchase.requestId || lot.category !== 'BOX'
      || norm(lot.productKey || lot.product) !== norm(opening.product)
      || String(lot.store || '') !== purchase.store
      || String(lot.acquiredAt || '') !== purchase.date
      || Number(lot.unitCost) !== purchase.unitCost || Number(lot.quantity) !== 1
      || String(lot.sourceTransactionId || '') !== transaction.id) {
      fail('canonical purchase and matching stock lot are not uniquely verified');
    }
    sources.push({ lotId, purchaseRequestId: purchase.requestId, store: purchase.store,
      acquiredAt: purchase.date, unitCost: purchase.unitCost, quantity: 1 });
  }
  if (new Set(sources.map(source => source.lotId)).size !== purchaseRows.length) fail('duplicate source lot');
  let working = canonical.payload;
  let provenanceCorrection = null;
  if (missingSources.length === 1) {
    const corrected = correctHistoricalSaleProvenance({
      canonical, sourceRows: purchaseRows, missingSource: missingSources[0], opening,
      excludedPurchaseRow, excludedSaleRow
    });
    working = corrected.payload;
    provenanceCorrection = corrected.correction;
  } else if (missingSources.length) {
    fail('multiple missing opening lots require manual review');
  } else if (excludedPurchaseRow) {
    const soldPurchase = validatedRow(excludedPurchaseRow, ['v2-applied']);
    const soldLotId = `chat-purchase-${soldPurchase.requestId}-lot`;
    if (canonical.payload.inventoryLots.some(lot => String(lot.id) === soldLotId)) {
      fail('excluded sold source still in stock without an attributable missing target');
    }
  }
  const expectedCost = sources.reduce((sum, source) => sum + source.unitCost, 0);
  const command = { ...opening, expectedRevision: canonical.revision, sourceLots: sources };
  const planned = applyChatCommand(working, command);
  if (provenanceCorrection) {
    const openingTx = planned.state.transactions.find(tx => tx.id === `chat-opening-${opening.requestId}`);
    openingTx.reconciledSaleTransactionId = provenanceCorrection.saleTransactionId;
    openingTx.reconciledSoldPurchaseRequestId = provenanceCorrection.sourcePurchaseRequestId;
    planned.state.auditLog.at(-1).provenanceCorrection = {
      saleTransactionId: provenanceCorrection.saleTransactionId,
      soldPurchaseRequestId: provenanceCorrection.sourcePurchaseRequestId,
      priorConsumedTargetLotId: provenanceCorrection.replacedMissingLotId
    };
    validateState(planned.state);
  }
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
    expectedCost, sourceLots: sources, provenanceCorrection, payload: planned.state };
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
  if (plan.provenanceCorrection) openedIds.add(plan.provenanceCorrection.reassignedFromLotId);
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
  if (plan.provenanceCorrection) {
    const correctedSale = after.payload.transactions.find(tx => tx.id === plan.provenanceCorrection.saleTransactionId);
    if (!correctedSale || correctedSale.sourcePurchaseRequestId !== plan.provenanceCorrection.sourcePurchaseRequestId
      || after.payload.inventoryLots.some(lot => lot.id === plan.provenanceCorrection.reassignedFromLotId)) {
      fail('historical sale source correction not verified on canonical readback');
    }
  }
  return { status: 'canonical-readback-verified', revision: after.revision,
    quantity: plan.quantity };
}
