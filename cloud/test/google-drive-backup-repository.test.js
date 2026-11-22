import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGoogleDriveBackupRepository } from '../src/google-drive-backup-repository.js';

const key = `v2/2026-11-08/revision-12-${'a'.repeat(64)}.json`;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function mockDrive() {
  const files = new Map();
  let nextId = 0;
  return {
    files,
    api: { files: {
      async generateIds() { nextId += 1; return { data: { ids: [`generated-drive-id-${nextId}`] } }; },
      async create({ requestBody, media, uploadType }) {
        assert.equal(uploadType, 'resumable');
        assert.equal(requestBody.parents[0], 'private-folder-id');
        if (files.has(requestBody.id)) throw { code: 409 };
        const entry = { ...requestBody, content: Buffer.from(media.body) };
        files.set(requestBody.id, entry);
        return { data: { id: entry.id, name: entry.name, mimeType: entry.mimeType, appProperties: entry.appProperties } };
      },
      async get({ fileId, alt }) {
        const entry = files.get(fileId);
        if (!entry) throw { code: 404 };
        if (alt === 'media') return { data: entry.content };
        return { data: { id: fileId, name: entry.name, mimeType: entry.mimeType, appProperties: entry.appProperties } };
      }
    } }
  };
}

function memoryRegistry() {
  const ids = new Map();
  return {
    async get(stableKey) { return ids.get(stableKey) || null; },
    async getOrCreate(stableKey, candidate) {
      if (!ids.has(stableKey)) ids.set(stableKey, candidate);
      return ids.get(stableKey);
    }
  };
}

test('Google Drive backup repository creates a private-keyed file and verifies byte-exact readback', async () => {
  const drive = mockDrive();
  const repository = createGoogleDriveBackupRepository({ drive: drive.api, idRegistry: memoryRegistry(), folderId: 'private-folder-id' });
  const content = Buffer.from('{"schemaVersion":2,"revision":12}');
  assert.deepEqual(await repository.putIfAbsent(key, content), { created: true });
  assert.deepEqual(await repository.get(key), content);
  const file = [...drive.files.values()][0];
  assert.equal(file.appProperties.tvBackupKeyHash, hash(key));
  assert.equal(file.appProperties.payloadSha256, hash(content));
  assert.equal(file.name.includes('schemaVersion'), false);
  assert.equal(JSON.stringify(file.appProperties).includes(key), false);
});

test('Drive create retries reuse the reserved ID and accept only a matching file', async () => {
  const drive = mockDrive();
  const registry = memoryRegistry();
  const repository = createGoogleDriveBackupRepository({ drive: drive.api, idRegistry: registry, folderId: 'private-folder-id' });
  const content = Buffer.from('{"backup":"synthetic"}');
  assert.deepEqual(await repository.putIfAbsent(key, content), { created: true });
  assert.deepEqual(await repository.putIfAbsent(key, content), { created: false });
  assert.equal(drive.files.size, 1);
  await assert.rejects(repository.putIfAbsent(key, Buffer.from('different payload')), /does not match/);
});

test('Drive repository fails closed for missing objects, invalid keys, and oversized content', async () => {
  const repository = createGoogleDriveBackupRepository({ drive: mockDrive().api, idRegistry: memoryRegistry(), folderId: 'private-folder-id' });
  await assert.rejects(repository.get(key), /not found/);
  await assert.rejects(repository.putIfAbsent('v2/not-a-valid-key', Buffer.from('x')), /backup key/);
  await assert.rejects(repository.putIfAbsent(key, Buffer.alloc(7_500_001)), /size/);
  assert.throws(() => createGoogleDriveBackupRepository({ drive: mockDrive().api, idRegistry: memoryRegistry(), folderId: '' }), /folder ID/);
});
