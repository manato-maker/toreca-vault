import { open, readFile } from 'node:fs/promises';
import { createBackupArtifact, parseBackupArtifact, previewBackupRestore, serializeBackupArtifact, verifyBackupArtifact } from '../src/backup-artifact.js';
import { createBackupExportTask } from '../src/backup-export-task.js';
import { createFileBackupRepository } from '../src/file-backup-repository.js';

function usage() {
  return 'Usage: backup-snapshot.js export <snapshot.json> <backup-directory> | create <snapshot.json> <backup.json> | verify <backup.json> | preview <backup.json> <current.json> <expected-revision>';
}

async function readJson(path) {
  const raw = await readFile(path);
  return JSON.parse(raw.toString('utf8'));
}

function printableVerification(verification) {
  return {
    valid: verification.valid,
    createdAt: verification.createdAt,
    revision: verification.revision,
    payloadHash: verification.payloadHash,
    artifactHash: verification.artifactHash,
    counts: verification.counts,
    inventory: verification.inventory
  };
}

async function main(args) {
  const [command, ...values] = args;
  if (command === 'export' && values.length === 2) {
    const snapshot = await readJson(values[0]);
    const task = createBackupExportTask({
      store: { async read() { return { payload: snapshot, revision: snapshot.revision }; } },
      repository: createFileBackupRepository(values[1])
    });
    process.stdout.write(JSON.stringify(await task()) + '\n');
    return;
  }
  if (command === 'create' && values.length === 2) {
    const snapshot = await readJson(values[0]);
    const artifact = createBackupArtifact(snapshot);
    const output = await open(values[1], 'wx', 0o600);
    try {
      await output.writeFile(serializeBackupArtifact(artifact), 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
    process.stdout.write(JSON.stringify(printableVerification(verifyBackupArtifact(artifact))) + '\n');
    return;
  }
  if (command === 'verify' && values.length === 1) {
    const raw = await readFile(values[0]);
    const parsed = parseBackupArtifact(raw);
    process.stdout.write(JSON.stringify(printableVerification(parsed.verification)) + '\n');
    return;
  }
  if (command === 'preview' && values.length === 3) {
    const artifact = await readJson(values[0]);
    const current = await readJson(values[1]);
    if (!/^\d+$/.test(values[2])) throw new Error('Expected revision must be a nonnegative integer');
    const preview = previewBackupRestore(artifact, current, { expectedCurrentRevision: Number(values[2]) });
    process.stdout.write(JSON.stringify(preview) + '\n');
    return;
  }
  process.stderr.write(usage() + '\n');
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Backup command failed; verify the input, output path, and revision, then retry.\n');
  process.exitCode = 1;
});
