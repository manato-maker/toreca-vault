import fs from 'node:fs/promises';
import { inspectV2Snapshot } from '../src/migration-report.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node cloud/scripts/report-snapshot.js <local-v2-json-file>');
  process.exitCode = 2;
} else {
  try {
    const raw = await fs.readFile(file);
    const snapshot = JSON.parse(raw.toString('utf8'));
    const report = inspectV2Snapshot(snapshot, raw);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.firestoreSnapshotFitsSafetyLimit) process.exitCode = 3;
  } catch (error) {
    console.error(`Snapshot inspection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
