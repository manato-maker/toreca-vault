import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, emptyV2 } from '../../v2/core.js';
import {
  createBackupArtifact, parseBackupArtifact, previewBackupRestore,
  serializeBackupArtifact, verifyBackupArtifact
} from '../src/backup-artifact.js';

function sampleSnapshot() {
  let state = applyTransaction(emptyV2(), {
    id: 'secret-transaction', type: 'purchase', product: 'Private Product',
    productKey: 'private-key', category: 'BOX', condition: 'あり',
    quantity: 2, unitCost: 1250, date: '2026-11-07'
  }, 'secret-mutation');
  state.lotteries.push({ id: 'private-lottery', status: '応募済' });
  state.inventoryLots.push({
    id: 'unknown-cost-lot', product: 'Private Product 2', productKey: 'private-key-2',
    category: 'パック', condition: '', quantity: 3, unitCost: null
  });
  return state;
}

test('backup artifact round-trips with payload and metadata hashes plus safe aggregates', () => {
  const snapshot = sampleSnapshot();
  const before = JSON.stringify(snapshot);
  const artifact = createBackupArtifact(snapshot, { createdAt: '2026-11-07T12:30:00.000Z' });
  const serialized = serializeBackupArtifact(artifact);
  const { artifact: parsed, verification } = parseBackupArtifact(serialized);
  assert.deepEqual(parsed, artifact);
  assert.equal(verification.valid, true);
  assert.equal(verification.revision, 1);
  assert.equal(verification.report.counts.transactions, 1);
  assert.equal(verification.report.counts.inventoryLots, 2);
  assert.equal(verification.inventory.totalQuantity, 5);
  assert.equal(verification.inventory.knownAcquisitionCost, 2500);
  assert.equal(verification.inventory.unknownCostLots, 1);
  assert.equal(JSON.stringify(snapshot), before);
  assert.notEqual(artifact.payloadHash, artifact.artifactHash);
});

test('backup verification rejects payload tampering, metadata tampering, and revision mismatch', () => {
  const artifact = createBackupArtifact(sampleSnapshot(), { createdAt: '2026-11-07T12:30:00.000Z' });
  const payloadTamper = structuredClone(artifact);
  payloadTamper.payload.inventoryLots[0].quantity += 1;
  assert.throws(() => verifyBackupArtifact(payloadTamper), /payload hash mismatch/);

  const metadataTamper = structuredClone(artifact);
  metadataTamper.createdAt = '2026-11-07T13:30:00.000Z';
  assert.throws(() => verifyBackupArtifact(metadataTamper), /metadata hash mismatch/);

  const revisionTamper = structuredClone(artifact);
  revisionTamper.revision += 1;
  assert.throws(() => verifyBackupArtifact(revisionTamper), /revision does not match payload/);

  const extraField = { ...artifact, warning: 'unexpected data' };
  assert.throws(() => verifyBackupArtifact(extraField), /unexpected fields/);

  const incompletePayload = structuredClone(artifact);
  delete incompletePayload.payload.automation;
  incompletePayload.payloadHash = artifact.payloadHash;
  assert.throws(() => verifyBackupArtifact(incompletePayload), /canonical V2 JSON/);
});

test('restore preview is manual-only, redacted, and guarded by an observed current revision', () => {
  const backupSnapshot = sampleSnapshot();
  const currentSnapshot = sampleSnapshot();
  currentSnapshot.revision = 2;
  const backup = createBackupArtifact(backupSnapshot, { createdAt: '2026-11-07T12:30:00.000Z' });
  const beforeBackup = JSON.stringify(backupSnapshot);
  const beforeCurrent = JSON.stringify(currentSnapshot);
  const preview = previewBackupRestore(backup, currentSnapshot, { expectedCurrentRevision: 2 });
  assert.equal(preview.status, 'manual-review-required');
  assert.equal(preview.automaticApply, false);
  assert.equal(preview.backup.revision, 1);
  assert.equal(preview.current.revision, 2);
  assert.equal(preview.backup.inventory.knownAcquisitionCost, 2500);
  const output = JSON.stringify(preview);
  assert.equal(output.includes('Private Product'), false);
  assert.equal(output.includes('secret-transaction'), false);
  assert.equal(output.includes('private-lottery'), false);
  assert.equal(JSON.stringify(backupSnapshot), beforeBackup);
  assert.equal(JSON.stringify(currentSnapshot), beforeCurrent);
  assert.throws(() => previewBackupRestore(backup, currentSnapshot, { expectedCurrentRevision: 1 }), /revision changed/);
});

test('backup parsing rejects malformed JSON, invalid snapshots, and oversized input', () => {
  assert.throws(() => parseBackupArtifact('{'), /not valid JSON/);
  assert.throws(() => createBackupArtifact({ schemaVersion: 1, revision: 0 }), /schemaVersion=2/);
  assert.throws(() => parseBackupArtifact(' '.repeat(7_500_001)), /size limit/);
});
