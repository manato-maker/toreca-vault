#!/usr/bin/env node
/**
 * Authenticated Cloud Shell only; PRIVATE local JSON file.
 *
 * node cloud/scripts/import-verified-buyback.js preview /path/to/private-quotes.json 12
 * TV2_VERIFIED_BUYBACK_IMPORT=YES TV2_BACKUP_VERIFIED=YES \
 *   node cloud/scripts/import-verified-buyback.js apply /path/to/private-quotes.json 12
 *
 * No direct API key or service account credential should ever appear in chat,
 * command-line arguments, GitHub, or a public cloud log.
 * The script validates evidence format but does not independently fetch X.
 */
import { readFile } from 'node:fs/promises';
import { createFirestoreStore } from '../src/firestore-store.js';
import { commitVerifiedBuybackImport } from '../src/verified-buyback-import.js';

const EXPECTED_PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const EXPECTED_DOC = 'torecaVaultStaging/canonical';

async function main([mode, input, rev]) {
  if (!['preview','apply'].includes(mode) || !input || !/^\d+$/.test(rev || '')) {
    throw new Error('Usage: import-verified-buyback.js preview|apply <private-json-file> <expected-revision>');
  }
  if (process.env.GOOGLE_CLOUD_PROJECT !== EXPECTED_PROJECT
    || process.env.TV2_FIRESTORE_DOCUMENT !== EXPECTED_DOC) {
    throw new Error('BLOCKED: only the dedicated staging canonical is permitted');
  }
  if (mode === 'apply' && (process.env.TV2_VERIFIED_BUYBACK_IMPORT !== 'YES'
    || process.env.TV2_BACKUP_VERIFIED !== 'YES')) {
    throw new Error('BLOCKED: explicit quote verification and verified canonical backup required');
  }
  const raw = await readFile(input, 'utf8');
  const payload = JSON.parse(raw);
  if (!payload || payload.schemaVersion !== 1
    || !Array.isArray(payload.quotes) || typeof payload.mutationId !== 'string') {
    throw new Error('private quote batch schema invalid');
  }
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({ projectId: EXPECTED_PROJECT });
  const store = createFirestoreStore(firestore, EXPECTED_DOC);
  const answer = await commitVerifiedBuybackImport({
    store, records: payload.quotes, expectedRevision: Number(rev),
    mutationId: payload.mutationId, apply: mode === 'apply'
  });
  // No quote text, prices, product names, account identifiers, posting URLs,
  // file paths, or personally identifying data are printed.
  process.stdout.write(JSON.stringify({ mode, ...answer }) + '\n');
}

main(process.argv.slice(2)).catch(() => {
  console.error('BLOCKED: quote import rejected, revision conflict, readback failure, or insufficient staging permission.');
  process.exitCode = 2;
});
