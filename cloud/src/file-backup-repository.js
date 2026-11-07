import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const KEY_PATTERN = /^v2\/\d{4}-\d{2}-\d{2}\/revision-\d+-[a-f0-9]{64}\.json$/;

function resolveKey(directory, key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error('Backup object key is invalid');
  const target = resolve(directory, key);
  const pathFromRoot = relative(directory, target);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('Backup object key is invalid');
  return target;
}

export function createFileBackupRepository(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('A backup directory is required');
  const root = resolve(directory);

  return {
    async putIfAbsent(key, value) {
      const path = resolveKey(root, key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await open(path, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') return { created: false };
        throw error;
      }
      try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
        return { created: true };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      } finally {
        await handle.close().catch(() => {});
      }
    },

    async get(key) {
      return readFile(resolveKey(root, key));
    }
  };
}
