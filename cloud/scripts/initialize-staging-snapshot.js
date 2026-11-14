import fs from 'node:fs/promises';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreStore } from '../src/firestore-store.js';
import { inspectV2Snapshot } from '../src/migration-report.js';

const TARGET_PROJECT = 'project-8ff0bbc4-675d-4596-a8a';
const TARGET_DOCUMENT = 'torecaVaultStaging/canonical';
const [filePath, expectedRevisionArg] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!filePath || !/^\d+$/.test(String(expectedRevisionArg || ''))) {
  fail('Usage: GOOGLE_CLOUD_PROJECT=project-8ff0bbc4-675d-4596-a8a node cloud/scripts/initialize-staging-snapshot.js <schema-v2-export.json> <expected-revision>');
} else if (process.env.GOOGLE_CLOUD_PROJECT !== TARGET_PROJECT) {
  fail('Refusing import: GOOGLE_CLOUD_PROJECT must be the dedicated staging project.');
} else {
  try {
    const sourceBytes = await fs.readFile(filePath);
    const envelope = JSON.parse(sourceBytes.toString('utf8'));
    const expectedRevision = Number(expectedRevisionArg);
    if (envelope?.app !== 'toreca-vault' || envelope.schemaVersion !== 2
      || !envelope.data || Number(envelope.revision) !== expectedRevision
      || Number(envelope.data.revision) !== expectedRevision) {
      throw new Error('export must be a matching Toreca Vault schemaVersion 2 envelope and expected revision');
    }
    const report = inspectV2Snapshot(envelope.data, sourceBytes);
    if (!report.firestoreSnapshotFitsSafetyLimit) {
      throw new Error('snapshot exceeds the staging Firestore safety limits');
    }

    const firestore = new Firestore({ projectId: TARGET_PROJECT });
    const store = createFirestoreStore(firestore, TARGET_DOCUMENT);
    const initialized = await store.initializeFromSnapshot(envelope.data);
    if (initialized.revision !== expectedRevision) {
      throw new Error('staging readback revision did not match the export');
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      targetProject: TARGET_PROJECT,
      targetDocument: TARGET_DOCUMENT,
      sourceRevision: report.revision,
      sourceSha256: report.sha256,
      storagePlan: report.firestoreStoragePlan,
      counts: {
        transactions: report.counts.transactions,
        inventoryLots: report.counts.inventoryLots,
        lotteries: report.counts.lotteries,
        marketQuotes: report.counts.marketQuotes,
        auditLogEntries: report.counts.auditLogEntries
      },
      readbackVerified: true
    }) + '\n');
  } catch (error) {
    fail('Staging snapshot initialization failed: ' + String(error?.message || 'unknown error'));
  }
}
