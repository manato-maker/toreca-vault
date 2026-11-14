import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyIntakeFailure, logIntakeFailure } from '../src/worker-error-diagnostics.js';

test('intake diagnostics categorizes known Sheet/Firestore errors without any raw details', () => {
  const cases = [
    [new Error('Google Sheets metadata lookup failed with HTTP 403'), 'sheets-permission'],
    [new Error('Google Sheets intake read failed with HTTP 404'), 'sheets-not-found'],
    [new Error('Google Sheets intake receipt write failed with HTTP 429'), 'sheets-rate-limit'],
    [new Error('Google Sheets intake read failed with HTTP 503'), 'sheets-upstream'],
    [new Error('configured spreadsheet is not the dedicated new-app intake sheet'), 'sheets-wrong-target'],
    [new Error('Google Sheets access token is unavailable'), 'sheets-auth'],
    [new Error('stored Sheets intake cursor has an unsupported schema'), 'intake-cursor'],
    [new Error('intake receipt transition would overwrite a finalized or unexpected row'), 'sheets-receipt-conflict'],
    [new Error('7 PERMISSION_DENIED from firestore'), 'firestore-permission'],
    [new Error('FAILED_PRECONDITION: The query requires an index'), 'firestore-index'],
    [new Error('unknown backend message containing private things'), 'unclassified']
  ];
  for (const [error, expected] of cases) {
    assert.deepEqual(classifyIntakeFailure('intake', error), { stage: 'intake', reasonCode: expected });
  }
});

test('unknown or private diagnostic fields cannot enter Cloud Run logs', () => {
  const leaked = 'private-product-name@example.com secret=do-not-log';
  const messages = [];
  const error = new Error(leaked, { cause: new Error('Google Sheets intake read failed with HTTP 403 token='+leaked) });
  const result = logIntakeFailure(line => messages.push(line), 'private-stage-'+leaked, error);
  assert.deepEqual(result, { stage: 'unknown', reasonCode: 'sheets-permission' });
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), {
    event: 'toreca-vault-intake-failure', stage: 'unknown', reasonCode: 'sheets-permission'
  });
  assert.ok(!messages[0].includes('private-product-name'));
  assert.ok(!messages[0].includes('token='));
  assert.ok(!messages[0].includes('secret='));
});

test('wrapped reconciliation error preserves safe stage, not raw cause in diagnostic line', () => {
  const original = new Error('Google Sheets intake receipt readback did not match');
  const wrapped = Object.assign(new Error('reconciliation failed', { cause: original }),
    { intakeStage: 'reconciliation' });
  let printed = '';
  logIntakeFailure(line => { printed = line; }, wrapped.intakeStage, wrapped);
  assert.deepEqual(JSON.parse(printed), {
    event: 'toreca-vault-intake-failure', stage: 'reconciliation', reasonCode: 'sheets-receipt-conflict'
  });
});

test('server catches actual worker exception with safe diagnostic, not original stack', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /logIntakeFailure\(console\.error, error\?\.intakeStage, error\)/);
  assert.match(server, /intakeStage: 'intake'/);
  assert.match(server, /intakeStage: 'reconciliation'/);
  assert.match(server, /Google Sheets intake failed/);
});
