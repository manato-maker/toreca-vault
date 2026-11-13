import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../src/dashboard-view.js';
import { createIapVerifier } from '../src/dashboard-auth.js';
import { createDashboardServer } from '../src/dashboard-server.js';

const SNAPSHOT = {
  schemaVersion: 2,
  inventoryLots: [
    { id: 'lot1', product: '<img src=x onerror=alert(1)>', category: 'BOX',
      quantity: 2, unitCost: 7200, acquiredAt: '2026-11-12' },
    { id: 'lot2', product: 'カードA', category: 'カード',
      quantity: 1, unitCost: 1000, acquiredAt: '2026-11-13' }
  ],
  marketQuotes: [{ lotId: 'lot1', price: 9900, source: '参考' }],
  transactions: [{ id: 'tx1', type: 'sale', product: '売却品', quantity: 1,
    price: 15000, fee: 500, acquisitionCost: 9000, date: '2026-11-12' }],
  lotteries: [{ id: 'a', title: '抽選A', resultDate: '2026-11-20', deadline: '2026-11-18' }]
};
const CURRENT = { payload: SNAPSHOT, revision: 2925, lastMutationId: 'm1' };

async function withDashboard(store, verifier, run) {
  const server = createDashboardServer({ store, verifyIap: verifier, now: () => new Date('2026-11-13T04:00:00Z') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('dashboard escapes product names and shows read-only stock, calendar and profit', () => {
  const html = renderDashboard(SNAPSHOT, 2925, '2026-11', new Date('2026-11-13T04:00:00Z'));
  assert.match(html, /資産ダッシュボード/);
  assert.match(html, /予定カレンダー/);
  assert.match(html, /在庫一覧/);
  assert.match(html, /確定売却益/);
  assert.match(html, /5,500/);
  assert.match(html, /11\/20/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /相場未取得/);
  assert.match(html, /原価を代用/);
});
test('invalid month falls back to current JST calendar and does not inject HTML', () => {
  const html = renderDashboard(SNAPSHOT, 1, '2026-11"><script>', new Date('2026-11-13T04:00:00Z'));
  assert.match(html, /2026年11月/);
  assert.doesNotMatch(html, /<script>/);
});
test('read-only dashboard denies access unless signed IAP assertion passes', async () => {
  let reads = 0, verifierCalls = 0;
  const store = { async read() { reads++; return CURRENT; } };
  await withDashboard(store, async () => { verifierCalls++; return false; }, async base => {
    const noAssertion = await fetch(base + '/app');
    assert.equal(noAssertion.status, 401);
    const rejected = await fetch(base + '/app', { headers: { 'x-goog-iap-jwt-assertion': 'bad' } });
    assert.equal(rejected.status, 403);
    assert.equal(reads, 0);
    assert.equal(verifierCalls, 1);
    const post = await fetch(base + '/app', { method: 'POST' });
    assert.equal(post.status, 405);
    const unknown = await fetch(base + '/api/v2');
    assert.equal(unknown.status, 404);
  });
});
test('authorized HTML response is noncacheable and does not expose API token', async () => {
  await withDashboard({ async read() { return CURRENT; } }, async () => true, async base => {
    const response = await fetch(base + '/app?month=2026-11', { headers: { 'x-goog-iap-jwt-assertion': 'signed-token' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /Toreca Vault/);
    assert.doesNotMatch(html, /TV2_API_TOKEN/);
  });
});
test('empty canonical fails closed without exposing storage internals', async () => {
  await withDashboard({ async read() { return null; } }, async () => true, async base => {
    const response = await fetch(base + '/', { headers: { 'x-goog-iap-jwt-assertion': 'signed' } });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not initialized/);
  });
});
test('IAP verifier requires correct email and cryptographically verified token', async () => {
  let verifyCalls = 0, keyCalls = 0;
  const oauthClient = {
    async getIapPublicKeys() { keyCalls++; return { pubkeys: { key1: 'fake public key' } }; },
    async verifySignedJwtWithCertsAsync(assertion, keys, aud, issuers) {
      verifyCalls++;
      assert.deepEqual(keys, { key1: 'fake public key' });
      assert.equal(aud, '/projects/235108293761/locations/asia-northeast1/services/toreca-vault-ui-staging');
      assert.deepEqual(issuers, ['https://cloud.google.com/iap']);
      return { getPayload: () => ({ sub: 'verified-user', email: assertion.includes('other') ? 'other@example.com' : 'user@example.com' }) };
    }
  };
  const verifier = createIapVerifier({
    audience: '/projects/235108293761/locations/asia-northeast1/services/toreca-vault-ui-staging',
    allowedEmails: 'User@Example.com',
    oauthClient
  });
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'key1' })).toString('base64url');
  const req = token => ({ headers: { 'x-goog-iap-jwt-assertion': token } });
  assert.equal(await verifier(req(header + '.payload.signature')), true);
  assert.equal(await verifier(req(header + '.other.signature')), false);
  assert.equal(keyCalls, 1);
  assert.equal(verifyCalls, 2);
  assert.equal(await verifier(req(Buffer.from('{"alg":"none"}').toString('base64url') + '.payload.signature')), false);
  assert.equal(verifyCalls, 2);
  assert.equal(await verifier({ headers: {} }), false);
});
test('IAP verifier rejects missing allowlist or audience at startup', () => {
  assert.throws(() => createIapVerifier({ audience: '', allowedEmails: 'user@example.com' }), /audience/);
  assert.throws(() => createIapVerifier({ audience: '/projects/1/locations/asia-northeast1/services/app', allowedEmails: '' }), /ALLOWED_EMAILS/);
});

test('sales filter lists every older sale even when mixed overview contains only purchases', () => {
  const manyPurchases = Array.from({length: 20}, (_, n) => ({
    id: 'p' + n, type: 'purchase', product: '新しい購入品' + n,
    date: '2026-11-12', quantity: 1, price: 100
  }));
  const oldSale = {
    id: 'old-sale', type: 'sale', product: '過去の売却商品',
    date: '2026-01-01', quantity: 2, price: 9000, fee: 1000, acquisitionCost: 12000
  };
  const sample = { ...SNAPSHOT, transactions: [...manyPurchases, oldSale] };
  const overview = renderDashboard(sample, 10, '2026-11', new Date('2026-11-13T04:00:00Z'));
  assert.match(overview, /21件中 直近12件/);
  assert.doesNotMatch(overview, /過去の売却商品/);
  assert.match(overview, /売却 1/);
  assert.match(overview, /type=sale#history/);

  const sales = renderDashboard(sample, 10, '2026-11', new Date('2026-11-13T04:00:00Z'), 'sale');
  assert.match(sales, /1件すべて/);
  assert.match(sales, /過去の売却商品/);
  assert.match(sales, /売却 · ￥17,000|売却 · ¥17,000/);
  assert.match(sales, /確定利益 [¥￥]5,000/);
  assert.doesNotMatch(sales, /新しい購入品/);
});
test('history filters only accept known types and escape transaction descriptions', () => {
  const sample = {
    ...SNAPSHOT,
    transactions: [
      { type: 'opening', id: 'o1', product: '<svg/onload=alert(1)>', quantity: 1, price: 0, date: '2026-11-10' },
      { type: 'sale', id: 's1', product: '利益原価未確認', quantity: 1, price: 100, acquisitionCost: null, date: '2026-11-11' }
    ]
  };
  const opening = renderDashboard(sample, 10, '2026-11', new Date('2026-11-13T04:00:00Z'), 'opening');
  assert.match(opening, /&lt;svg\/onload=alert\(1\)&gt;/);
  assert.doesNotMatch(opening, /<svg\/onload/);
  assert.doesNotMatch(opening, /利益原価未確認/);
  const sale = renderDashboard(sample, 10, '2026-11', new Date('2026-11-13T04:00:00Z'), 'sale');
  assert.match(sale, /原価未確認/);
  const unknown = renderDashboard(sample, 10, '2026-11', new Date('2026-11-13T04:00:00Z'), 'sale"><script>');
  assert.match(unknown, /すべて 2/);
  assert.doesNotMatch(unknown, /<script>/);
});
test('signed IAP request can safely view older sales through GET history filter', async () => {
  const record = { ...CURRENT, payload: {
    ...SNAPSHOT, transactions: [
      ...Array.from({ length: 15 }, (_, n) => ({
        id: 'p' + n, type: 'purchase', product: 'recent ' + n,
        date: '2026-11-12', quantity: 1, price: 50
      })),
      { id: 's1', type: 'sale', product: 'historic sale', date: '2026-05-01', quantity: 1,
        price: 5000, acquisitionCost: 3000, fee: 0 }
    ]
  }};
  let reads = 0;
  await withDashboard({ async read() { reads++; return record; } }, async () => true, async base => {
    const response = await fetch(base + '/app?type=sale', { headers: { 'x-goog-iap-jwt-assertion': 'signed' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /historic sale/);
    assert.doesNotMatch(html, /recent 0/);
    assert.equal(reads, 1);
  });
});


test('handover links point to the live private Google Doc and validate document IDs', () => {
  const validId = '1oXxw0pm8YoTCRMwQI16TiITDrtBBE9Gy-54kj90qlz0';
  const html = renderDashboard(SNAPSHOT, 2925, '2026-11', new Date('2026-11-13T04:00:00Z'), 'all', validId);
  assert.match(html, /Chat \/ Work 共通/);
  assert.match(html, /引き継ぎをダウンロード/);
  assert.match(html, new RegExp('docs\\.google\\.com/document/d/' + validId + '/export\\?format=txt'));
  assert.match(html, /href="#handover"/);
  assert.doesNotMatch(html, /APIトークン/);
  const unsafe = renderDashboard(SNAPSHOT, 2925, '2026-11', new Date('2026-11-13T04:00:00Z'), 'all', 'evil"><script>alert(1)</script>');
  assert.doesNotMatch(unsafe, /id="handover"/);
  assert.doesNotMatch(unsafe, /<script>alert/);
  const absent = renderDashboard(SNAPSHOT, 2925);
  assert.doesNotMatch(absent, /id="handover"/);
});
test('handover links require the same verified IAP identity as the dashboard', async () => {
  const docId = '1oXxw0pm8YoTCRMwQI16TiITDrtBBE9Gy-54kj90qlz0';
  const server = createDashboardServer({
    store: { async read() { return CURRENT; } },
    verifyIap: async request => request.headers['x-goog-iap-jwt-assertion'] === 'accepted',
    handoverDocId: docId
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const bad = await fetch(base + '/app');
    assert.equal(bad.status, 401);
    const forbidden = await fetch(base + '/app', { headers: { 'x-goog-iap-jwt-assertion': 'bad' } });
    assert.equal(forbidden.status, 403);
    const ok = await fetch(base + '/app', { headers: { 'x-goog-iap-jwt-assertion': 'accepted' } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /引き継ぎをダウンロード/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
