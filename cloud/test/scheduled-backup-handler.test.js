import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledBackupHandler } from '../src/scheduled-backup-handler.js';

const receipt = {
  created: true, revision: 7,
  payloadHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64),
  counts: { transactions: 9999 }
};

test('binds the daily backup job and returns only an integrity receipt', async () => {
  let calls = 0;
  const handler = createScheduledBackupHandler({ exportBackup: async () => { calls++; return receipt; } });
  const result = await handler({
    kind: 'canonical-backup', jobKey: 'canonical-backup:2026-11-07', scheduledAt: '2026-11-07T02:00+09:00'
  });
  assert.deepEqual(result, {
    created: true, revision: 7, payloadHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64)
  });
  assert.equal(calls, 1);
});

test('rejects a wrong day or scheduled slot before export', async () => {
  let calls = 0;
  const handler = createScheduledBackupHandler({ exportBackup: async () => { calls++; return receipt; } });
  await assert.rejects(handler({ kind: 'canonical-backup', jobKey: 'canonical-backup:2026-11-07', scheduledAt: '2026-11-07T02:15+09:00' }), /scheduled daily/);
  assert.equal(calls, 0);
});

test('fails closed on an invalid backup integrity receipt', async () => {
  const handler = createScheduledBackupHandler({ exportBackup: async () => ({ ...receipt, artifactHash: 'bad' }) });
  await assert.rejects(handler({
    kind: 'canonical-backup', jobKey: 'canonical-backup:2026-11-07', scheduledAt: '2026-11-07T02:00+09:00'
  }), /invalid integrity receipt/);
});
