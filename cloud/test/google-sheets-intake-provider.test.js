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

test('receipt writes update only D:G and require matching readback', async () => {
  const requests = [];
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      if (requests.length === 2) return ok({ values: [['request:1', '{"requestId":"request:1"}', '', 'new']] });
      if (requests.length === 3) return ok({ updatedCells: 4 });
      return ok({ values: [['queued', 'accepted', 'request:1', 123]] });
    }
  });
  const result = await provider.writeReceipt(7, {
    status: 'queued', resultCode: 'accepted', acceptedRequestId: 'request:1', processedAtMs: 123
  });
  assert.deepEqual(result, { updated: true });
  assert.match(requests[1].url, /Intake!A7%3AD7/);
  assert.equal(requests[1].init.method, 'GET');
  assert.match(requests[2].url, /Intake!D7%3AG7/);
  assert.equal(requests[2].init.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    majorDimension: 'ROWS', values: [['queued', 'accepted', 'request:1', 123]]
  });
  assert.equal(requests[3].init.method, 'GET');
  assert.match(requests[3].url, /Intake!D7%3AG7/);
});

test('receipt write fails closed when readback is missing or differs', async () => {
  for (const values of [undefined, [['review', 'accepted', 'request:1', 123]]]) {
    let calls = 0;
    const provider = createGoogleSheetsIntakeProvider({
      spreadsheetId: SHEET_ID,
      getAccessToken: async () => token,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
        if (calls === 2) return ok({ values: [['request:1', '{"requestId":"request:1"}', '', 'new']] });
        if (calls === 3) return ok({ updatedCells: 4 });
        return ok(values ? { values } : {});
      }
    });
    await assert.rejects(provider.writeReceipt(8, {
      status: 'queued', resultCode: 'accepted', acceptedRequestId: 'request:1', processedAtMs: 123
    }), /readback did not match/);
  }
});

test('receipt write refuses to update a row whose source request ID no longer matches', async () => {
  let calls = 0;
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      return ok({ values: [['request:other', '{"requestId":"request:other"}', '', 'new']] });
    }
  });
  await assert.rejects(provider.writeReceipt(9, {
    status: 'v2-applied', resultCode: 'canonical-readback-verified', acceptedRequestId: 'request:1', processedAtMs: 123
  }), /request ID changed/);
  assert.equal(calls, 2);
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


test('review receipt allows blank accepted ID but still verifies the original source ID', async () => {
  let n = 0;
  const calls = [];
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      ++n;
      if (n === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      if (n === 2) return ok({ values: [['chat:lottery:noid', '{"type":"lottery"}', '', 'new']] });
      if (n === 3) return ok({ updatedCells: 4 });
      return ok({ values: [['review', 'lottery-identity-missing', '', 500]] });
    }
  });
  assert.deepEqual(await provider.writeReceipt(10, {
    status: 'review', resultCode: 'lottery-identity-missing', acceptedRequestId: '', processedAtMs: 500
  }, 'chat:lottery:noid'), { updated: true });
  assert.equal(calls[2].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[2].init.body).values, [['review', 'lottery-identity-missing', '', 500]]);
});

test('business duplicate receipt can point to another already accepted request', async () => {
  let n = 0;
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async () => {
      ++n;
      if (n === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      if (n === 2) return ok({ values: [['chat:duplicate:2', '{"type":"lottery"}', '', 'new']] });
      if (n === 3) return ok({ updatedCells: 4 });
      return ok({ values: [['duplicate', 'business-duplicate', 'gmail:original:1', 999]] });
    }
  });
  assert.deepEqual(await provider.writeReceipt(11, {
    status: 'duplicate', resultCode: 'business-duplicate', acceptedRequestId: 'gmail:original:1', processedAtMs: 999
  }, 'chat:duplicate:2'), { updated: true });
});

test('review/duplicate receipt fails closed on source row replacement', async () => {
  let n = 0;
  const provider = createGoogleSheetsIntakeProvider({
    spreadsheetId: SHEET_ID,
    getAccessToken: async () => token,
    fetchImpl: async () => {
      ++n;
      if (n === 1) return ok({ properties: { title: googleSheetsIntakeSchema.title }, sheets: [{ properties: { title: 'Intake' } }] });
      return ok({ values: [['chat:other:2', '', '', 'new']] });
    }
  });
  await assert.rejects(provider.writeReceipt(12, {
    status: 'review', resultCode: 'invalid-input', acceptedRequestId: '', processedAtMs: 10
  }, 'chat:old:1'), /request ID changed/);
  assert.equal(n, 2);
});
