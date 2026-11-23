#!/usr/bin/env node
/**
 * Manual, staging-only verification/repair of an EXISTING 2-BOX Intake opening.
 * Strictly read-only without --apply, the correct live revision, an operator
 * opt-in, and the staging intake Scheduler PAUSED. No legacy or production APIs.
 *
 * This script has no hardcoded product, merchant, requestId, or personal data.
 * It reads them from the existing PRIVATE Intake and Firestore canonical.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createFirestoreStore } from '../src/firestore-store.js';
import { createFirestoreCommandQueue } from '../src/firestore-command-queue.js';
import { createGoogleSheetsIntakeProvider } from '../src/google-sheets-intake-provider.js';
import { parseGoogleSheetsIntakeRow } from '../src/google-sheets-intake.js';
import { planScopedBoxOpeningRepair, applyScopedBoxOpeningRepair } from '../src/scoped-box-opening-repair.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const NUMBER = '235108293761';
const REGION = 'asia-northeast1';
const SERVICE = 'toreca-vault-staging';
const JOB = 'toreca-vault-staging-intake';
const DOCUMENT = 'torecaVaultStaging/canonical';
const SHEET_HASH = 'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad';
const PURCHASE_ROWS = [56, 57];
const EXCLUDED_PURCHASE_ROW = 58;
const EXCLUDED_SALE_ROW = 61;
const OPENING_ROW = 64;

class Blocked extends Error {}

function cli(...args) {
  try {
    return execFileSync('gcloud', args, { encoding: 'utf8', timeout: 45000, maxBuffer: 500000 }).trim();
  } catch {
    throw new Blocked('Google Cloud authentication/metadata unavailable; no data changed');
  }
}
function cliJson(...args) {
  try { return JSON.parse(cli(...args)); }
  catch { throw new Blocked('Google Cloud returned invalid metadata'); }
}
function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--inspect') return { apply: false };
  if (argv.length === 3 && argv[0] === '--apply' && argv[1] === '--expected-revision'
    && /^(0|[1-9][0-9]*)$/.test(argv[2]) && Number.isSafeInteger(Number(argv[2]))) {
    return { apply: true, expectedRevision: Number(argv[2]) };
  }
  throw new Blocked('usage: --inspect OR --apply --expected-revision <exact-current-revision>');
}
function verifiedStagingConfiguration({ apply }) {
  if (cli('projects', 'describe', PROJECT, '--format=value(projectNumber)') !== NUMBER) {
    throw new Blocked('wrong GCP project number');
  }
  const service = cliJson('run', 'services', 'describe', SERVICE,
    '--project', PROJECT, '--region', REGION, '--format=json');
  const active = (service.status?.traffic || []).filter(x => x.percent > 0);
  if (active.length !== 1 || active[0].percent !== 100
    || !String(active[0].revisionName || '').startsWith(SERVICE + '-')) {
    throw new Blocked('staging serving revision is not uniquely identified');
  }
  const revision = cliJson('run', 'revisions', 'describe', active[0].revisionName,
    '--project', PROJECT, '--region', REGION, '--format=json');
  const environment = Object.fromEntries((revision.spec?.containers?.[0]?.env || [])
    .filter(x => x && typeof x.name === 'string').map(x => [x.name, x.value]));
  const id = environment.TV2_NEW_APP_INTAKE_SPREADSHEET_ID;
  if (!id || createHash('sha256').update(id).digest('hex') !== SHEET_HASH
    || environment.TV2_FIRESTORE_DOCUMENT !== DOCUMENT) {
    throw new Blocked('serving revision is not bound to the expected private staging data');
  }
  const job = cliJson('scheduler', 'jobs', 'describe', JOB,
    '--project', PROJECT, '--location', REGION, '--format=json');
  const target = job.httpTarget || {};
  const serviceUrl = String(service.status?.url || '');
  if (!serviceUrl.startsWith('https://' + SERVICE + '-')
    || !serviceUrl.endsWith('.run.app')
    || target.uri !== serviceUrl + '/internal/worker/sheets-intake'
    || target.httpMethod !== 'POST') {
    throw new Blocked('staging Intake Scheduler endpoint differs from known target');
  }
  if (apply && job.state !== 'PAUSED') {
    throw new Blocked('pause the existing staging Intake Scheduler job before scoped repair');
  }
  if (apply && (environment.TV2_ENABLE_WRITES !== 'true'
    || environment.TV2_ENABLE_COMMAND_QUEUE !== 'true'
    || environment.TV2_ENABLE_COMMAND_WORKER !== 'true')) {
    throw new Blocked('staging worker configuration unexpected');
  }
  if (apply) {
    let jobs;
    try {
      jobs = JSON.parse(cli('scheduler', 'jobs', 'list', '--project', PROJECT,
        '--location', REGION, '--format=json'));
    } catch {
      throw new Blocked('staging Scheduler jobs cannot be safely enumerated');
    }
    assertCommandWorkerPaused(jobs, serviceUrl);
  }
  return id;
}

/** The running command worker must not be able to claim the source request concurrently. */
export function assertCommandWorkerPaused(jobs, serviceUrl) {
  if (!Array.isArray(jobs) || !serviceUrl || typeof serviceUrl !== 'string') {
    throw new Blocked('staging command Scheduler job list is unavailable');
  }
  const endpoint = serviceUrl + '/internal/worker/commands';
  const matching = jobs.filter(job => job?.httpTarget?.uri === endpoint);
  if (matching.length !== 1 || matching[0].state !== 'PAUSED'
    || matching[0].httpTarget.httpMethod !== 'POST') {
    throw new Blocked('exactly one authenticated staging command worker Scheduler must be PAUSED');
  }
}

/** Read-only, privacy-preserving source-lot status for operator diagnosis. */
export function classifyRepairSources({ canonical, purchaseRows, excludedPurchaseRow }) {
  if (!canonical?.payload || !Array.isArray(canonical.payload.inventoryLots)
    || !Number.isSafeInteger(canonical.revision)
    || !Array.isArray(purchaseRows) || purchaseRows.length !== 2) {
    throw new Blocked('canonical or target evidence unreadable');
  }
  const classify = row => {
    const cmd = parseGoogleSheetsIntakeRow(row).command;
    const id = `chat-purchase-${cmd.requestId}-lot`;
    const lot = canonical.payload.inventoryLots.find(l => String(l.id || '') === id);
    if (!lot) return 'missing';
    const matches = lot.requestId === cmd.requestId
      && lot.category === 'BOX'
      && String(lot.store || '') === String(cmd.store || '')
      && String(lot.acquiredAt || '') === String(cmd.date || '')
      && Number(lot.unitCost) === Number(cmd.unitCost)
      && Number(lot.quantity) === 1;
    return matches ? 'present-and-matched' : 'present-but-mismatched';
  };
  return { revision: canonical.revision,
    targets: purchaseRows.map(classify),
    excluded: classify(excludedPurchaseRow) };
}

function privateBackup(canonical) {
  const home = process.env.HOME;
  if (typeof home !== 'string' || !home.startsWith('/')) {
    throw new Blocked('operator HOME unavailable for a private snapshot backup');
  }
  const dir = join(home, '.toreca-vault-staging-private-backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = 'before-scoped-opening-rev-' + canonical.revision + '-' + Date.now() + '.json';
  const file = join(dir, name);
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ project: PROJECT, document: DOCUMENT,
      capturedAt: new Date().toISOString(), snapshot: canonical }) + '\n', 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return file;
}

async function row(provider, number) {
  const items = await provider.readRows({ startRow: number, limit: 1 });
  if (items.length !== 1 || items[0].rowNumber !== number) {
    throw new Blocked('expected original Intake source row missing');
  }
  return items[0];
}
function originalOpening(rowValue) {
  return parseGoogleSheetsIntakeRow(rowValue).command;
}

export async function run({ apply, expectedRevision, store, queue, provider, spreadsheetId, output = console.log, backup = privateBackup } = {}) {
  const [openingRow, ...sourceRows] = await Promise.all([
    row(provider, OPENING_ROW), ...PURCHASE_ROWS.map(number => row(provider, number))
  ]);
  const excluded = await row(provider, EXCLUDED_PURCHASE_ROW);
  const excludedSale = await row(provider, EXCLUDED_SALE_ROW);
  const otherPurchase = parseGoogleSheetsIntakeRow(excluded).command;
  const otherSale = parseGoogleSheetsIntakeRow(excludedSale).command;
  if (String(excluded.values[3] || '') !== 'v2-applied'
    || String(excludedSale.values[3] || '') !== 'v2-applied'
    || otherPurchase.type !== 'purchase' || otherSale.type !== 'sale'
    || otherPurchase.product !== otherSale.product
    || otherPurchase.quantity !== 1 || otherSale.quantity !== 1) {
    throw new Blocked('separate previously sold BOX evidence differs from verified Intake');
  }
  const opening = originalOpening(openingRow);
  const queueRow = await queue.inspect(opening.requestId);
  if (queueRow && (queueRow.status !== 'pending'
    || JSON.stringify(queueRow.command) !== JSON.stringify(opening))) {
    throw new Blocked('existing repair request is not an identical pending command');
  }
  const canonical = await store.read();
  const sourceStatus = classifyRepairSources({ canonical, purchaseRows: sourceRows,
    excludedPurchaseRow: excluded });
  output('Canonical revision: ' + sourceStatus.revision);
  output('Source lot 1: ' + sourceStatus.targets[0]);
  output('Source lot 2: ' + sourceStatus.targets[1]);
  output('Excluded sold-source lot: ' + sourceStatus.excluded);
  const direct = sourceStatus.targets.every(s => s === 'present-and-matched')
    && sourceStatus.excluded === 'missing';
  const potentialOldFifo = sourceStatus.targets.filter(s => s === 'missing').length === 1
    && sourceStatus.targets.filter(s => s === 'present-and-matched').length === 1
    && sourceStatus.excluded === 'present-and-matched';
  if (!direct && !potentialOldFifo) {
    throw new Blocked('source-lot discrepancy; no writes. Manual provenance review required');
  }
  const plan = planScopedBoxOpeningRepair({
    canonical, openingRow, purchaseRows: sourceRows,
    excludedRequestIds: [otherPurchase.requestId],
    excludedPurchaseRow: excluded, excludedSaleRow: excludedSale
  });
  output('Historical sale provenance correction planned: ' + Boolean(plan.provenanceCorrection));
  output('PASS: original private Intake evidence and staging source lots match');
  output('Expected canonical revision: ' + plan.expectedRevision);
  output('Planned opened BOX quantity: ' + plan.quantity);
  output('Planned acquisition cost kept in purchase history (yen): ' + plan.expectedCost);
  if (!apply) {
    output('READ ONLY: no Intake, queue or Firestore writes were attempted');
    return { status: 'inspect-only', revision: plan.expectedRevision };
  }
  if (process.env.TV_STAGING_REPAIR_APPROVED !== 'true'
    || expectedRevision !== plan.expectedRevision) {
    throw new Blocked('explicit approval and matching expected revision required');
  }
  if (plan.provenanceCorrection && process.env.TV_STAGING_PROVENANCE_REPAIR_APPROVED !== 'true') {
    throw new Blocked('separate historical sale provenance repair approval is required');
  }
  // Snapshot backup is a hard prerequisite to any queue, sheet or Firestore change. 
  backup(canonical);
  output('PASS: private local staging snapshot backup written before mutation');
  const spreadsheetIdHash = createHash('sha256').update(spreadsheetId).digest('hex');
  const queued = await queue.enqueue({
    requestId: opening.requestId, command: opening,
    intakeReceipt: { spreadsheetIdHash, rowNumber: OPENING_ROW }
  });
  if (!queued.accepted || queued.businessDuplicate) {
    throw new Blocked('original repair request could not be queued idempotently');
  }
  if (String(openingRow.values[3]) === 'new') {
    await provider.writeReceipt(OPENING_ROW, {
      status: 'queued', resultCode: 'accepted', acceptedRequestId: opening.requestId,
      processedAtMs: Date.now()
    }, opening.requestId);
  }
  const claim = await queue.claim(opening.requestId, { now: Date.now(), leaseMs: 300000, maxAttempts: 3 });
  if (!claim.claimed || JSON.stringify(claim.command) !== JSON.stringify(opening)) {
    throw new Blocked('original command could not be exclusively claimed');
  }

  let saved = false;
  try {
    // Read the current canonical again after claiming; never trust a stale plan.
    const nowState = await store.read();
    if (!nowState || nowState.revision !== plan.expectedRevision) {
      throw new Blocked('canonical revision drift after claim');
    }
    const fresh = planScopedBoxOpeningRepair({
      canonical: nowState, openingRow, purchaseRows: sourceRows,
      excludedRequestIds: [otherPurchase.requestId],
      excludedPurchaseRow: excluded, excludedSaleRow: excludedSale
    });
    if (JSON.stringify(fresh.provenanceCorrection) !== JSON.stringify(plan.provenanceCorrection)) {
      throw new Blocked('source provenance plan changed since dry-run');
    }
    const result = await applyScopedBoxOpeningRepair({ store, plan: fresh });
    saved = true;
    const settled = await queue.finish(opening.requestId, claim.claimToken, {
      outcome: 'done', resultCode: 'v2-applied', now: Date.now()
    });
    if (!settled.updated) throw new Blocked('canonical was saved but queue settlement needs recovery');
    await provider.writeReceipt(OPENING_ROW, {
      status: 'v2-applied', resultCode: 'canonical-readback-verified',
      acceptedRequestId: opening.requestId, processedAtMs: Date.now()
    }, opening.requestId);
    const finalized = await queue.setIntakeReceiptStatus(opening.requestId, { state: 'final' });
    if (!finalized.updated) throw new Blocked('canonical verified, but Intake receipt finalization failed');
    output('PASS: canonical opening, queue settlement and original Intake receipt verified');
    output('Canonical revision after repair: ' + result.revision);
    return { status: 'canonical-readback-verified', revision: result.revision };
  } catch (error) {
    if (!saved) {
      // Original request remains retryable; no other original Intake is touched.
      await queue.finish(opening.requestId, claim.claimToken, {
        outcome: 'pending', resultCode: 'retryable-error', now: Date.now()
      }).catch(() => {});
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.apply && process.env.TV_STAGING_REPAIR_APPROVED !== 'true') {
    throw new Blocked('write approval is disabled');
  }
  const spreadsheetId = verifiedStagingConfiguration(args);
  const { GoogleAuth } = await import('google-auth-library');
  const scopes = args.apply ? ['https://www.googleapis.com/auth/spreadsheets']
    : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const client = await new GoogleAuth({ scopes }).getClient();
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ projectId: PROJECT });
  const store = createFirestoreStore(firestore, DOCUMENT);
  const queue = createFirestoreCommandQueue(firestore);
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId,
    getAccessToken: async () => {
      const value = await client.getAccessToken();
      return typeof value === 'string' ? value : value?.token;
    }
  });
  return run({ ...args, store, queue, provider, spreadsheetId });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('BLOCKED: ' + (error instanceof Blocked
      ? error.message : 'private read/repair verification failed; details withheld'));
    process.exitCode = 2;
  });
}
