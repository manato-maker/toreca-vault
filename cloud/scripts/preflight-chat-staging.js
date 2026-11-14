#!/usr/bin/env node
/**
 * Read-only staging readiness probe. Cloud Shell/operator use only.
 * Never displays private transactions, names, tokens or canonical payload.
 * No writes to Firestore, Sheets, Cloud Run or Cloud Scheduler.
 */
import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';
import { validateState } from '../../v2/core.js';
import { createFirestoreStore } from '../src/firestore-store.js';

const PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const DOCUMENT = 'torecaVaultStaging/canonical';
const SHEET_ID = '14rWGcmJnqFOdh9VfTlHZvC5wjcBdsW0D5XvYh8DQOAc';
const SHEET_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID;

async function sheetsGet(client, path) {
  const auth = await client.getAccessToken();
  const token = typeof auth === 'string' ? auth : auth?.token;
  if (!token) throw new Error('Sheets authentication unavailable');
  const response = await fetch(SHEET_ROOT + path, {
    headers: { authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('Sheets read failed (status ' + response.status + ')');
  return response.json();
}

export async function preflight({
  createStore = async () => createFirestoreStore(new Firestore({ projectId: PROJECT }), DOCUMENT),
  createClient = async () => (await new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  }).getClient()),
  readSheet = sheetsGet,
  output = console.log
} = {}) {
  const result = { canonical: false, sheet: false, warnings: [] };
  const store = await createStore();
  const current = await store.read();
  if (!current?.payload || !Number.isSafeInteger(current.revision) || current.revision < 0) {
    throw new Error('staging canonical is absent or revision invalid; do not enable command worker');
  }
  validateState(current.payload);
  const payload = current.payload;
  result.canonical = true;
  result.revision = current.revision;
  output('PASS: staging canonical schema and revision valid');
  output('Counts only: transactions=' + payload.transactions.length +
    ', inventory lots=' + payload.inventoryLots.length +
    ', lotteries=' + payload.lotteries.length);
  if (current.revision === 0) result.warnings.push('canonical revision is zero; verify initialization provenance');

  const client = await createClient();
  const metadata = await readSheet(client, '?fields=' + encodeURIComponent('properties.title,sheets.properties.title'));
  const titles = (metadata.sheets || []).map(s => s.properties?.title);
  if (metadata.properties?.title !== 'Toreca Vault New App Intake' || !titles.includes('Intake')) {
    throw new Error('isolated intake spreadsheet metadata does not match');
  }
  result.sheet = true;
  const range = encodeURIComponent('Intake!D2:G1000');
  const cells = await readSheet(client, '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE');
  const counts = {};
  for (const row of Array.isArray(cells.values) ? cells.values : []) {
    const state = String(row?.[0] ?? '');
    if (state) counts[state] = (counts[state] || 0) + 1;
  }
  for (const state of ['new', 'queued', 'review', 'v2-applied', 'duplicate']) {
    output('Intake receipt ' + state + ': ' + (counts[state] || 0));
  }
  if ((counts.queued || 0) > 0 || (counts.new || 0) > 0) {
    result.warnings.push('pending intake records: check worker/Scheduler before Chat go-ahead');
  }
  if ((counts.review || 0) > 0) {
    result.warnings.push('review records exist: never bypass or resubmit under new IDs');
  }
  output('Read-only preflight: PASS; no Firestore or Sheet records mutated');
  output('GCP Billing/Scheduler/IAM and mobile E2E remain separate release gates.');
  for (const warning of result.warnings) output('REVIEW: ' + warning);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflight().catch(() => {
    console.error('BLOCKED: readiness probe failed or lacked permission. Check Cloud Shell IAM and staging configuration.');
    process.exitCode = 2;
  });
}
