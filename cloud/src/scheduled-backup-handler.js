/** Bind the daily ledger job to an injected create-once backup export task. */
export function createScheduledBackupHandler({ exportBackup } = {}) {
  if (typeof exportBackup !== 'function') throw new TypeError('a backup export task is required');
  return async function handleCanonicalBackup(job) {
    const match = /^canonical-backup:(\d{4}-\d{2}-\d{2})$/.exec(String(job?.jobKey || ''));
    if (job?.kind !== 'canonical-backup' || !match
      || job.scheduledAt !== `${match[1]}T02:00+09:00`) {
      throw new TypeError('a scheduled daily canonical-backup job is required');
    }
    const result = await exportBackup();
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0
      || !/^[a-f0-9]{64}$/.test(String(result.payloadHash || ''))
      || !/^[a-f0-9]{64}$/.test(String(result.artifactHash || ''))) {
      throw new Error('backup export returned an invalid integrity receipt');
    }
    return {
      created: Boolean(result.created),
      revision: result.revision,
      payloadHash: result.payloadHash,
      artifactHash: result.artifactHash
    };
  };
}
