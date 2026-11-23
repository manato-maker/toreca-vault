#!/usr/bin/env node
/**
 * READ ONLY forensic diagnosis of the 2026-11-22 OP-18 source lots.
 * The original Intake evidence has been independently checked through the
 * connected owner's Sheets account. This script does NOT read Sheets or
 * assume Cloud Shell has Sheets access/impersonation permissions.
 *
 * Keep the fixed source hashes rather than source data in the repository.
 * This program has no write, enqueue, scheduler-trigger or retry path.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const NUMBER = '235108293761';
const REGION = 'asia-northeast1';
const SERVICE = 'toreca-vault-staging';
const DOCUMENT = 'torecaVaultStaging/canonical';
const DATE = '2026-11-22';
const UNIT_COST = 5760;
const PRODUCT_DIGEST = 'd2dfbc1d35c53dd04b0f60ed31a997987916e81b20e8b85d4cd4d7dc83b1523d';

export const SOURCE_EVIDENCE = Object.freeze({
  FURUICHI: Object.freeze({
    idHash: '1b857517c007064ff7149d717d60b1330a6374a16236c32acc584179cce6cf2b',
    storeHash: '54fa63cae5dd01baf007a9804c816ba2be3a57ab1603afa017e67ca80af4a62b'
  }),
  BIC: Object.freeze({
    idHash: '399bede9fe558b9e3ae9b465fefad05a1071cefdaebc82271eb46a86dd5bf587',
    storeHash: '2260aee21bbe6cf4cdf16673e9b2bded4f2f2e363ed1f4506c38deca8411a004'
  }),
  MINT: Object.freeze({
    idHash: '438ceab52c76d5203ba04fd2f3ed7e4f9f19e0c7aa504b2983ddc561adc97186',
    storeHash: '3735c0f7c314ff50c5af215c41ed2283ed09a9f8d15339ff463b731408d7c2d5'
  })
});
const SALE_EVIDENCE = Object.freeze({
  idHash: '9cb762dfc88090c7fe15a7f0945ea7cfe35ec4c18db5a3a890fd99e94a995f65',
  storeHash: '3594f4cd00ceaaf9ad17774d658d538ba7162cd6e94cacd1dc985a452cbc93a8'
});
const OPENING_HASH = '7b3a00c2513769733a652fb09c155d3586f9362c0c06c388996c6353e8527437';

function hash(value) { return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex'); }
function norm(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, '');
}
function hashNorm(value) { return hash(norm(value)); }
function block(message) { throw new Error('BLOCKED: ' + message); }
function projectCheck(commandRunner = execFileSync) {
  let number;
  try {
    number = String(commandRunner('gcloud', ['projects', 'describe', PROJECT,
      '--format=value(projectNumber)'], { encoding: 'utf8', timeout: 20000 })).trim();
  } catch { block('staging project verification failed; no writes'); }
  if (number !== NUMBER) block('wrong project; no writes');
}
function validPurchase(tx, evidence) {
  return tx?.type === 'purchase'
    && tx.category === 'BOX'
    && Number(tx.quantity) === 1 && Number(tx.price) === UNIT_COST
    && tx.date === DATE
    && hashNorm(tx.productKey || tx.product) === PRODUCT_DIGEST
    && hashNorm(tx.store) === evidence.storeHash;
}
function validLot(lot, evidence, tx) {
  return lot?.category === 'BOX' && Number(lot.quantity) === 1
    && Number(lot.unitCost) === UNIT_COST && lot.acquiredAt === DATE
    && hashNorm(lot.productKey || lot.product) === PRODUCT_DIGEST
    && hashNorm(lot.store) === evidence.storeHash
    && lot.requestId === tx.requestId && lot.sourceTransactionId === tx.id;
}

/** Verify only immutable source evidence and current lot states. */
export function inspectCanonical(canonical, {
  sources = SOURCE_EVIDENCE, sale = SALE_EVIDENCE, openingHash = OPENING_HASH
} = {}) {
  if (!canonical || !Number.isSafeInteger(canonical.revision)
    || canonical.revision < 0 || !canonical.payload
    || canonical.revision !== canonical.payload.revision
    || !Array.isArray(canonical.payload.transactions)
    || !Array.isArray(canonical.payload.inventoryLots)) block('canonical document invalid');
  const state = canonical.payload;
  const details = {};
  for (const [label, expected] of Object.entries(sources)) {
    const matches = state.transactions.filter(tx => hash(tx.requestId) === expected.idHash);
    if (matches.length !== 1 || !validPurchase(matches[0], expected)
      || matches[0].id !== 'chat-purchase-' + matches[0].requestId) {
      block(label + ' original purchase evidence differs from canonical');
    }
    const purchase = matches[0];
    const lotId = 'chat-purchase-' + purchase.requestId + '-lot';
    const matchesLots = state.inventoryLots.filter(lot =>
      hash(lot.requestId) === expected.idHash || lot.id === lotId);
    if (matchesLots.length > 1 || (matchesLots.length === 1
      && (matchesLots[0].id !== lotId || !validLot(matchesLots[0], expected, purchase)))) {
      block(label + ' inventory source lot inconsistent');
    }
    details[label] = matchesLots.length === 1 ? 'present-and-matched' : 'missing';
  }
  const sales = state.transactions.filter(tx => hash(tx.requestId) === sale.idHash);
  if (sales.length !== 1 || sales[0].id !== 'chat-sale-' + sales[0].requestId
    || sales[0].type !== 'sale' || sales[0].category !== 'BOX'
    || sales[0].date !== DATE || Number(sales[0].price) !== 9000
    || Number(sales[0].quantity) !== 1
    || hashNorm(sales[0].productKey || sales[0].product) !== PRODUCT_DIGEST
    || hashNorm(sales[0].store) !== sale.storeHash) {
    block('Mint transaction original sale evidence differs from canonical');
  }
  const openings = state.transactions.filter(tx => hash(tx.requestId) === openingHash);
  if (openings.length > 1) block('duplicate opening request entries require manual review');
  const alreadyOpened = openings.length === 1;
  if (alreadyOpened && (openings[0].type !== 'opening' || openings[0].quantity !== 2
    || hashNorm(openings[0].productKey || openings[0].product) !== PRODUCT_DIGEST)) {
    block('existing opening transaction differs from original report');
  }
  const target = [details.FURUICHI, details.BIC];
  const direct = target.every(v => v === 'present-and-matched') && details.MINT === 'missing';
  const historicFifo = target.filter(v => v === 'missing').length === 1
    && target.filter(v => v === 'present-and-matched').length === 1
    && details.MINT === 'present-and-matched';
  return {
    revision: canonical.revision,
    sourceLots: details,
    opening: alreadyOpened ? 'already-recorded' : 'not-recorded',
    pattern: alreadyOpened ? 'already-opened-needs-receipt-verification'
      : direct ? 'exact-two-target-lots'
        : historicFifo ? 'possible-historical-FIFO-misattribution'
          : 'manual-review-required',
    purchaseHistoryVerified: true,
    saleHistoryVerified: true
  };
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--inspect') {
    block('only --inspect is permitted (never --apply, --retry or --write)');
  }
  projectCheck();
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ projectId: PROJECT });
  const store = createFirestoreStore(firestore, DOCUMENT);
  let canonical;
  try { canonical = await store.read(); }
  catch (error) {
    const status = String(error?.code ?? error?.status ?? '');
    block('Firestore canonical read unavailable (' + (
      ['7','403','PERMISSION_DENIED'].includes(status) ? 'permission-denied'
        : ['16','401','UNAUTHENTICATED'].includes(status) ? 'unauthenticated'
          : ['5','404','NOT_FOUND'].includes(status) ? 'not-found'
            : 'read-failed') + '); no writes');
  }
  const result = inspectCanonical(canonical);
  console.log('PASS: exact staging canonical evidence checked; READ ONLY');
  console.log('Canonical revision: ' + result.revision);
  console.log('Furuichi target lot: ' + result.sourceLots.FURUICHI);
  console.log('BicCamera target lot: ' + result.sourceLots.BIC);
  console.log('Mint sale source lot: ' + result.sourceLots.MINT);
  console.log('Mint sale transaction: verified');
  console.log('Original opening: ' + result.opening);
  console.log('Source pattern: ' + result.pattern);
  console.log('NO Sheets read, impersonation, IAM changes, queue triggers or writes');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(String(error?.message || '').startsWith('BLOCKED:')
      ? error.message : 'BLOCKED: private staging read could not be verified; no writes');
    process.exitCode = 2;
  });
}
