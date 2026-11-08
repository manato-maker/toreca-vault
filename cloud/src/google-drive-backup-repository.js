import { createHash } from 'node:crypto';

const KEY_PATTERN = /^v2\/\d{4}-\d{2}-\d{2}\/revision-\d+-[a-f0-9]{64}\.json$/;
const MAX_BACKUP_BYTES = 7_500_000;
const MIME_TYPE = 'application/json';

function validateKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new TypeError('backup key is invalid');
  return key;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('backup content must be a string, Buffer, or Uint8Array');
}

function responseData(response) {
  return response?.data ?? response;
}

function isConflict(error) {
  return Number(error?.code) === 409 || Number(error?.response?.status) === 409;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Optional Drive repository. A durable ID registry must be backed by Firestore,
 * and Drive OAuth/folder setup is intentionally left to a later runtime decision.
 */
export function createGoogleDriveBackupRepository({ drive, idRegistry, folderId } = {}) {
  if (!drive?.files || typeof drive.files.generateIds !== 'function'
    || typeof drive.files.create !== 'function' || typeof drive.files.get !== 'function') {
    throw new TypeError('a Google Drive files client is required');
  }
  if (!idRegistry || typeof idRegistry.get !== 'function' || typeof idRegistry.getOrCreate !== 'function') {
    throw new TypeError('a durable backup ID registry is required');
  }
  if (typeof folderId !== 'string' || !folderId.trim()) throw new TypeError('a private Drive backup folder ID is required');

  async function fileIdFor(key) {
    const existing = await idRegistry.get(key);
    if (existing) return existing;
    const generatedResponse = await drive.files.generateIds({ count: 1, space: 'drive', type: 'files' });
    const candidateId = responseData(generatedResponse)?.ids?.[0];
    if (typeof candidateId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(candidateId)) {
      throw new Error('Google Drive did not return a valid generated file ID');
    }
    return idRegistry.getOrCreate(key, candidateId);
  }

  async function metadataFor(fileId) {
    const response = await drive.files.get({ fileId, fields: 'id,name,mimeType,appProperties' });
    return responseData(response);
  }

  async function verifyExisting(fileId, keyHash, payloadHash) {
    const metadata = await metadataFor(fileId);
    if (metadata?.id !== fileId
      || metadata?.appProperties?.tvBackupKeyHash !== keyHash
      || metadata?.appProperties?.payloadSha256 !== payloadHash) {
      throw new Error('existing Drive backup does not match the requested key and payload');
    }
  }

  return {
    async putIfAbsent(key, value) {
      const stableKey = validateKey(key);
      const content = asBuffer(value);
      if (!content.length || content.length > MAX_BACKUP_BYTES) {
        throw new RangeError('backup object size is outside the allowed limit');
      }
      const fileId = await fileIdFor(stableKey);
      const keyDigest = sha256(stableKey);
      const payloadDigest = sha256(content);
      const requestBody = {
        id: fileId,
        name: `toreca-vault-backup-${keyDigest}.json`,
        mimeType: MIME_TYPE,
        parents: [folderId.trim()],
        appProperties: {
          tvBackupKeyHash: keyDigest,
          payloadSha256: payloadDigest
        }
      };
      try {
        const created = responseData(await drive.files.create({
          requestBody,
          media: { mimeType: MIME_TYPE, body: content },
          uploadType: 'resumable',
          fields: 'id,name,mimeType,appProperties'
        }));
        if (created?.id !== fileId
          || created?.appProperties?.tvBackupKeyHash !== keyDigest
          || created?.appProperties?.payloadSha256 !== payloadDigest) {
          throw new Error('Google Drive create returned mismatched backup metadata');
        }
        return { created: true };
      } catch (error) {
        if (!isConflict(error)) throw error;
        await verifyExisting(fileId, keyDigest, payloadDigest);
        return { created: false };
      }
    },

    async get(key) {
      const stableKey = validateKey(key);
      const fileId = await idRegistry.get(stableKey);
      if (!fileId) throw new Error('Drive backup object was not found');
      const keyDigest = sha256(stableKey);
      const metadata = await metadataFor(fileId);
      if (metadata?.id !== fileId || metadata?.appProperties?.tvBackupKeyHash !== keyDigest) {
        throw new Error('Drive backup metadata does not match the requested key');
      }
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      const data = responseData(response);
      const content = Buffer.isBuffer(data) ? data
        : data instanceof Uint8Array ? Buffer.from(data)
          : typeof data === 'string' ? Buffer.from(data, 'utf8') : null;
      if (!content || !content.length || content.length > MAX_BACKUP_BYTES) {
        throw new RangeError('Drive backup content is outside the allowed limit');
      }
      if (typeof metadata?.appProperties?.payloadSha256 !== 'string'
        || metadata.appProperties.payloadSha256 !== sha256(content)) {
        throw new Error('Drive backup payload hash does not match its metadata');
      }
      return content;
    }
  };
}
