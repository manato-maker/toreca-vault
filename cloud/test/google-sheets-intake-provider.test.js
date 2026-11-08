import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleSheetsIntakeProvider, googleSheetsIntakeSchema } from '../src/google-sheets-intake-provider.js';

const SHEET_ID = '1abcdefghijklmnopqrstuvwxyz0123456789';
const token = 'synthetic-access-token-for-test';

function ok(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('provider verifies dedicated spreadsheet title and tab before reading pending rows', async () => {
  const requests = [];
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      return ok({ range: 'Intake!A2:D21', values: [['request:1', '{"requestId":"request:1"}', '', 'new']] });
    }
  });
  const rows = await provider.readRows({ limit: 20 });
  assert.deepEqual(rows, [{ rowNumber: 2, values: ['request:1', '{"requestId":"request:1"}', '', 'new'] }]);
  assert.match(requests[0].url, /spreadsheets\/1abcdefghijklmnopqrstuvwxyz0123456789\?/);
  assert.match(requests[1].url, /Intake!A2%3AD21/);
  assert.equal(requests[1].init.headers.authorization, `Bearer ${token}`);
  assert.equal(requests.some((request) => JSON.stringify(request).includes(token)), true);
});

test('wrong spreadsheet title or missing intake tab fails closed before reading cells', async () => {
  for (const metadata of [
    { properties: { title: 'Toreca Vault V2 Command Queue' }, sheets: [{ properties: { title: 'Queue' } }] },
    { properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Queue' } }] }
  ]) {
    let calls = 0;
    const provider = createGoogleSheetsIntakeProvider({
      spreadsheetId: SHEET_ID,
      getAccessToken: async () => token,
      fetchImpl: async () => { calls++; return ok(metadata); }
    });
    await assert.rejects(provider.readRows(), /dedicated new-app intake sheet/);
    assert.equal(calls, 1);
  }
});

test('provider reads the bounded page from the durable append cursor row', async () => {
  const requests = [];
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      return ok({ values: [['sheet:later:1', '{"requestId":"sheet:later:1","type":"purchase"}', '', 'new']] });
    }
  });
  const rows = await provider.readRows({ startRow: 42, limit: 20 });
  assert.equal(rows[0].rowNumber, 42);
  assert.match(requests[1], /Intake!A42%3AD61/);
  await assert.rejects(provider.readRows({ startRow: 1 }), /startRow/);
});

test('receipt writes update only D:G and require a four-cell API acknowledgement', async () => {
  const requests = [];
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      return ok({ updatedCells: 4 });
    }
  });
  const result = await provider.writeReceipt(7, {
    status: 'queued', resultCode: 'accepted', acceptedRequestId: 'request:1', processedAtMs: 123
  });
  assert.deepEqual(result, { updated: true });
  assert.match(requests[1].url, /Intake!D7%3AG7/);
  assert.equal(requests[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    majorDimension: 'ROWS', values: [['queued', 'accepted', 'request:1', 123]]
  });
});

test('provider rejects unsafe token, row bounds, invalid receipt, and API errors without returning response body', async () => {
  const noToken = createGoogleSheetsIntakeProvider({ spreadsheetId: SHEET_ID, getAccessToken: async () => '' });
  await assert.rejects(noToken.readRows(), /access token is unavailable/);

  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async () => ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] })
  });
  await assert.rejects(provider.writeReceipt(1, { status: 'queued', resultCode: 'accepted', acceptedRequestId: 'x', processedAtMs: 1 }), /rowNumber/);
  await assert.rejects(provider.writeReceipt(2, { status: 'done', resultCode: 'accepted', acceptedRequestId: 'x', processedAtMs: 1 }), /receipt is invalid/);

  const apiFailure = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async () => new Response('secret payload should not escape', { status: 403 })
  });
  await assert.rejects(apiFailure.readRows(), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.message.includes('secret payload'), false);
    return true;
  });
});
