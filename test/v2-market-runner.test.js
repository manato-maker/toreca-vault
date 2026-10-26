import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../automation/V2Automation.gs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/tv2-market-refresh.yml', import.meta.url), 'utf8');
assert.match(workflow, /cron:\s*'30 4 \* \* \*'/, 'daily fallback runs at 13:30 Japan time');
assert.match(workflow, /workflow_run:[\s\S]*workflows:\s*\[Apps Script Automation Deploy\]/, 'initial refresh waits for successful Apps Script deployment');
assert.match(workflow, /paths:\s*\['\.github\/workflows\/tv2-market-refresh\.yml'\]/, 'workflow edits can trigger a one-time verification run');
assert.match(workflow, /runTv2MarketRefreshNowOnce/);
assert.match(workflow, /runTv2MarketScheduledOnce/);
assert.match(workflow, /grep -Eiq.*true/, 'workflow accepts only a successful V2 read-back');
const start = source.indexOf('// Scoped GitHub Actions entry points.');
const end = source.indexOf('function tv2EnsurePickupSchedule_()', start);
assert.ok(start >= 0 && end > start, 'scoped market runner entry points are present');

function setup(drafts = []) {
  const calls = [];
  const payload = {
    revision: 2200,
    lastMutationId: 'market-refresh-test',
    inventoryLots: [
      { id: 'box-1', category: 'BOX', product: 'Example BOX', quantity: 1 },
      { id: 'pack-1', category: 'パック', product: 'Example Pack', quantity: 2 }
    ],
    marketQuotes: [
      { lotId: 'box-1', price: 12000, checkedAt: '2026-10-26', source: '相場店', fresh: true },
      { lotId: 'pack-1', price: 500, checkedAt: '2026-10-25', source: '相場店', fresh: true }
    ],
    automation: { health: { lastMarketRunAt: '2026-10-26T08:00:00.000Z', marketStatus: 'ok', marketReview: 0 } }
  };
  const context = vm.createContext({
    TZ: 'Asia/Tokyo',
    Utilities: { formatDate: () => '2026-10-26' },
    tv2Load_: () => ({ revision: 2200, payload }),
    tv2Health_: state => state.automation.health,
    runTv2MarketAuto: options => { calls.push(options); return { changed: true, report: { updated: 1, review: 0 } }; },
    tv2ProcessChatTradeDrafts_: () => calls.push('process-market-audit'),
    GmailApp: { getDrafts: () => drafts },
    normalize_: value => String(value || '').toLowerCase()
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, calls };
}

{
  const { context, calls } = setup();
  const result = vm.runInContext('runTv2MarketRefreshNowOnce()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { skipQueue: true, scheduled: false, skipScheduleEnsure: true });
  assert.equal(calls.includes('process-market-audit'), false, 'does not inspect or run the Gmail queue when no audit is queued');
  assert.equal(result.revision, 2200, 'summary is based on a canonical V2 reread');
  assert.equal(result.sealedLots, 2);
  assert.equal(result.sealedQuotesCurrent, 1);
}

{
  const audit = { getMessage: () => ({ getSubject: () => '[Toreca Vault Command]', getPlainBody: () => '{"type":"market-audit"}' }) };
  const { context, calls } = setup([audit]);
  vm.runInContext('runTv2MarketRefreshNowOnce()', context);
  assert.equal(calls[0].scheduled, false, 'manual refresh forces a fresh run even if today has a recorded run');
  assert.equal(calls[1], 'process-market-audit', 'only the read-only market audit is allowed to run after refresh');
}

{
  const { context, calls } = setup();
  const result = vm.runInContext('runTv2MarketScheduledOnce()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { skipQueue: true, scheduled: true, skipScheduleEnsure: true });
  assert.equal(calls.length, 1, 'scheduled runner leaves all Gmail command drafts untouched');
  assert.equal(result.lastScheduledMarketDate, '', 'readback reports the canonical scheduled-run marker');
}
