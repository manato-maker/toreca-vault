import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../scripts/release-chat-staging.sh', import.meta.url));
const source = readFileSync(path, 'utf8');

test('guarded staging release script is valid bash without running cloud commands', (t) => {
  const result = spawnSync('bash', ['-n', path], { encoding: 'utf8', timeout: 5000 });
  if (result.error?.code === 'ENOENT') return t.skip('bash unavailable');
  assert.equal(result.status, 0, result.stderr);
});

test('staging release never sets env vars, deploys at zero traffic and requires approval to promote', () => {
  for (const marker of [
    'project-8ff0bbc4-675d-4596-a8a', '235108293761',
    'toreca-vault-staging', 'torecaVaultStaging/canonical',
    'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad',
    '--no-traffic', '--tag=chat-candidate', '--min-instances=0',
    '--max-instances=1', '--cpu-throttling', '--no-allow-unauthenticated', 'TV2_STAGING_RELEASE_REVIEWED',
    'preflight-chat-staging.js', '--to-revisions=',
    'services get-iam-policy'
  ]) {
    assert.ok(source.includes(marker), 'missing protection: ' + marker);
  }
  assert.ok(source.includes('no --set-env-vars or --set-secrets'));
  assert.doesNotMatch(source, /^\s*gcloud run deploy.*--set-env-vars/m);
  assert.doesNotMatch(source, /^\s*gcloud run deploy.*--set-secrets/m);
  assert.doesNotMatch(source, /(?:allUsers|allAuthenticatedUsers).*roles\/run\.invoker.*add-iam-policy/);
});
