import { createHash } from 'node:crypto';

const KEY_PATTERN = /^v2\/\d{4}-\d{2}-\d{2}\/revision-\d+-[a-f0-9]{64}\.json$/;
const MAX_BACKUP_BYTES = 7_500_000;

function objectKey(value) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new TypeError('backup object key is invalid');
  }
  return value;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('backup content must be a string or Buffer');
}

function isPreconditionFailure(error) {
  return Number(error?.code) === 412 || Number(error?.response?.status) === 412;
}

/** Create-once Cloud Storage repository. Bucket location and lifecycle are configured separately. */
export function createGcsBackupRepository(bucket) {
  if (!bucket || typeof bucket.file !== 'function') throw new TypeError('a Cloud Storage bucket is required');

  return {
    async putIfAbsent(key, value) {
      const name = objectKey(key);
      const content = asBuffer(value);
      if (!content.length || content.length > MAX_BACKUP_BYTES) {
        throw new RangeError('backup object size is outside the allowed limit');
      }
      const sha256 = createHash('sha256').update(content).digest('hex');
      const file = bucket.file(name);
      try {
        await file.save(content, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: 'application/json',
            metadata: { backupSchemaVersion: '1', sha256 }
          }
        });
        return { created: true };
      } catch (error) {
        if (isPreconditionFailure(error)) return { created: false };
        throw error;
      }
    },

    async get(key) {
      const name = objectKey(key);
      const [content] = await bucket.file(name).download();
      const result = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (!result.length || result.length > MAX_BACKUP_BYTES) {
        throw new RangeError('backup object size is outside the allowed limit');
      }
      return result;
    }
  };
}
