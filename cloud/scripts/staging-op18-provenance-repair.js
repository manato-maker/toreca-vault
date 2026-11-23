#!/usr/bin/env node
/**
 * Exact 2026-11-22 OP-18 staging repair, with no Sheets API dependency.
 * --inspect is ALWAYS read-only. --apply is an explicitly approved operator
 * action, restricted to the original Intake #64 request and revision-CAS.
 *
 * Original Intake purchase/source evidence (56-58), sale (61) and opening
 * (64) were checked through the owner's connected Sheets access. Source IDs,
 * merchant/product attributes are verified against stable SHA256 digests.
 * No new request or Intake row is ever created.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';
import { planScopedBoxOpeningRepair, applyScopedBoxOpeningRepair } from '../src/scoped-box-opening-repair.js';
import { SOURCE_EVIDENCE, SALE_EVIDENCE, inspectCanonical } from './staging-op18-canonical-inspect.js';
import { privateBackup, verifiedStagingConfiguration } from './staging-scoped-opening-once.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const DOCUMENT = 'torecaVaultStaging/canonical';
const DATE = '2026-11-22';
const OPENING_REQUEST_ID = 'normalchat:2026-11-23:op18:furuichi-biccamera:open-box-2';
const OPENING_MEMO = 'ユーザー指示：ふるいち久宝寺店とビックカメラ アリオ八尾店で購入した開封用各1BOX、合計2BOXを開封扱い。残パック数の報告なし。';
const ORIGINAL_SALE_MEMO = 'ユーザー報告および買取ミミ画像：神の支配9,000円×1。対応するMint Games購入1BOXは同日Intake行に記録。';
const ORIGINAL_OPENING_HASH = '7b3a00c2513769733a652fb09c155d3586f9362c0c06c388996c6353e8527437';
const SHEET_HASH = 'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad';
const OPENING_ROW = 64;

function hash(v) { return createHash('sha256').update(String(v || ''), 'utf8').digest('hex'); }
function blocked(code) { throw new Error('BLOCKED: ' + code); }
function row(number, command, status) {
  return { rowNumber: number, values: [command.requestId, JSON.stringify(command), '', status] };
}

/** Pure reconstruction of the previously verified source evidence (not a new intake). */
export function buildCanonicalOnlyOpeningPlan(canonical) {
  const diag = inspectCanonical(canonical);
  if (diag.opening !== 'not-recorded' || diag.pattern !== 'possible-historical-FIFO-misattribution'
    || diag.sourceLots.FURUICHI !== 'present-and-matched'
    || diag.sourceLots.BIC !== 'missing'
    || diag.sourceLots.MINT !== 'present-and-matched') {
    blocked('current staging source pattern changed; manual review required');
  }
  if (hash(OPENING_REQUEST_ID) !== ORIGINAL_OPENING_HASH) blocked('original opening identity changed');
  const txByHash = source => {
    const matches = canonical.payload.transactions.filter(tx => hash(tx.requestId) === source.idHash);
    if (matches.length !== 1) blocked('source evidence is no longer unique');
    return matches[0];
  };
  const purchase = key => {
    const tx = txByHash(SOURCE_EVIDENCE[key]);
    // inspectCanonical already required the source ID, store, product, date, cost and quantity.
    return {
      requestId: tx.requestId,
      type: 'purchase',
      product: tx.product,
      category: tx.category,
      quantity: tx.quantity,
      unitCost: tx.price,
      date: tx.date,
      store: tx.store
    };
  };
  const purchases = {
    furuichi: purchase('FURUICHI'),
    biccamera: purchase('BIC'),
    mint: purchase('MINT')
  };
  const saleTx = txByHash(SALE_EVIDENCE);
  const sale = {
    requestId: saleTx.requestId,
    type: 'sale',
    product: saleTx.product,
    category: saleTx.category,
    quantity: saleTx.quantity,
    unitPrice: saleTx.price,
    date: saleTx.date,
    store: saleTx.store,
    memo: ORIGINAL_SALE_MEMO
  };
  const opening = {
    requestId: OPENING_REQUEST_ID,
    type: 'open-box',
    product: purchases.furuichi.product,
    quantity: 2,
    date: DATE,
    memo: OPENING_MEMO
  };
  const evidence = {
    canonical,
    openingRow: row(OPENING_ROW, opening, 'new'),
    purchaseRows: [row(56, purchases.furuichi, 'v2-applied'),
      row(57, purchases.biccamera, 'v2-applied')],
    excludedPurchaseRow: row(58, purchases.mint, 'v2-applied'),
    excludedSaleRow: row(61, sale, 'v2-applied'),
    excludedRequestIds: [purchases.mint.requestId]
  };
  const plan = planScopedBoxOpeningRepair(evidence);
  if (plan.expectedRevision !== diag.revision
    || plan.quantity !== 2 || plan.expectedCost !== 11520
    || !plan.provenanceCorrection
    || plan.provenanceCorrection.sourcePurchaseRequestId !== purchases.mint.requestId
    || plan.provenanceCorrection.saleTransactionId !== 'chat-sale-' + saleTx.requestId
    || plan.provenanceCorrection.replacedMissingLotId
      !== 'chat-purchase-' + purchases.biccamera.requestId + '-lot'
    || plan.sourceLots[0].purchaseRequestId !== purchases.furuichi.requestId
    || plan.sourceLots[1].purchaseRequestId !== purchases.biccamera.requestId
    || plan.openingRequestId !== OPENING_REQUEST_ID) {
    blocked('source-bound repair plan conflicts with the original report');
  }
  return { plan, opening, diagnosis: diag };
}

export function checkOriginalQueue(queueRow, opening, spreadsheetIdHash = SHEET_HASH) {
  if (queueRow == null) return;
  if (queueRow.status !== 'pending'
    || JSON.stringify(queueRow.command) !== JSON.stringify(opening)
    || queueRow.intakeReceipt?.spreadsheetIdHash !== spreadsheetIdHash
    || queueRow.intakeReceipt?.rowNumber !== OPENING_ROW) {
    blocked('original Intake command already queued differently, in progress or settled');
  }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--inspect') return { apply: false };
  if (args.length === 3 && args[0] === '--apply' && args[1] === '--expected-revision'
    && /^(0|[1-9]\d*)$/.test(args[2]) && Number.isSafeInteger(Number(args[2]))) {
    return { apply: true, expectedRevision: Number(args[2]) };
  }
  blocked('usage: --inspect OR --apply --expected-revision R');
}

export async function run({ store, queue, apply = false, expectedRevision, backup = privateBackup, out = console.log } = {}) {
  if (!store || !queue) blocked('canonical store and existing queue are required');
  const canonical = await store.read();
  const { plan, opening, diagnosis } = buildCanonicalOnlyOpeningPlan(canonical);
  const currentQueue = await queue.inspect(opening.requestId);
  checkOriginalQueue(currentQueue, opening);
  out('PASS: original source purchase/sale/opening evidence verified without Sheets');
  out('Canonical revision: ' + diagnosis.revision);
  out('Verified source pattern: ' + diagnosis.pattern);
  out('Corrected sale source: Mint Games (original transaction maintained)');
  out('Exact opening targets: Furuichi 1 BOX, BicCamera 1 BOX');
  out('Opening quantity: 2 BOX; preserved purchase cost: 11520 yen');
  out('Existing opening request: ' + (currentQueue ? 'same-pending-queue-record' : 'not-yet-queued'));
  if (!apply) {
    out('READ ONLY: no queue, canonical, Scheduler or Intake writes');
    return { status: 'inspect-only', revision: diagnosis.revision };
  }
  if (process.env.TV_STAGING_REPAIR_APPROVED !== 'true'
    || process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED !== 'true'
    || expectedRevision !== plan.expectedRevision) {
    blocked('separate approval flags and exact expected revision required; no writes');
  }
  // All external Scheduler pause/serving-identity checks are a hard caller
  // prerequisite. The CLI verifies them BEFORE entering this function.
  backup(canonical); // private 0600 local copy, before any mutation
  out('PASS: private canonical backup written');
  const accepted = await queue.enqueue({
    requestId: opening.requestId, command: opening,
    intakeReceipt: { spreadsheetIdHash: SHEET_HASH, rowNumber: OPENING_ROW }
  });
  if (!accepted.accepted || accepted.businessDuplicate || accepted.status !== 'pending') {
    blocked('original queue enqueue verification failed; no canonical save');
  }
  const claim = await queue.claim(opening.requestId, {
    now: Date.now(), leaseMs: 300000, maxAttempts: 3
  });
  if (!claim.claimed || JSON.stringify(claim.command) !== JSON.stringify(opening)) {
    blocked('could not exclusively claim exact original Intake request; no canonical save');
  }
  let persisted = false;
  try {
    const reRead = await store.read();
    if (reRead.revision !== plan.expectedRevision) blocked('canonical revision drift before save');
    const refreshed = buildCanonicalOnlyOpeningPlan(reRead).plan;
    if (JSON.stringify(refreshed.provenanceCorrection) !== JSON.stringify(plan.provenanceCorrection)
      || JSON.stringify(refreshed.sourceLots) !== JSON.stringify(plan.sourceLots)) {
      blocked('provenance evidence changed while claiming request');
    }
    const saved = await applyScopedBoxOpeningRepair({ store, plan: refreshed });
    persisted = true;
    const finished = await queue.finish(opening.requestId, claim.claimToken, {
      outcome: 'done', resultCode: 'v2-applied', now: Date.now()
    });
    if (!finished.updated) blocked('canonical saved; queue settlement needs manual reconciliation');
    out('PASS: staging canonical opening and original queue done/v2-applied');
    out('New revision: ' + saved.revision);
    out('NOTICE: original Intake row 64 receipt is not edited by this script; verify and reconcile separately');
    return { status: 'canonical-readback-verified-queue-done', revision: saved.revision };
  } catch (error) {
    if (!persisted) await queue.finish(opening.requestId, claim.claimToken,
      { outcome: 'pending', resultCode: 'retryable-error', now: Date.now() }).catch(() => {});
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.apply && (process.env.TV_STAGING_REPAIR_APPROVED !== 'true'
    || process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED !== 'true')) {
    blocked('separate write and historical-sale correction approvals required');
  }
  // Full serving-revision, project, Sheet binding, intake scheduler and worker
  // isolation checks happen before the first Firestore access.
  verifiedStagingConfiguration({ apply: options.apply });
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: PROJECT });
  const store = createFirestoreStore(db, DOCUMENT);
  const queue = createFirestoreCommandQueue(db);
  return run({ ...options, store, queue });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = String(error?.message || '');
    console.error(message.startsWith('BLOCKED:') ? message
      : 'BLOCKED: staging preflight or repair failed; details withheld. Review private logs locally, never retry blindly');
    process.exitCode = 2;
  });
}
