import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceGmailScanPage, planGmailScanPage } from '../src/gmail-scan-planner.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('first Gmail scan is bounded to a seven-day backfill with a fixed upper bound', () => {
  const nowMs = Date.parse('2026-11-03T12:00:00Z');
  const page = planGmailScanPage({ nowMs });
  assert.equal(page.cursor.sinceMs, nowMs - 7 * DAY);
  assert.equal(page.cursor.untilMs, nowMs);
  assert.equal(page.maxResults, 100);
  assert.equal(page.pageToken, null);
  assert.match(page.query, /from:info@pokemoncenter-online\.com/);
  assert.match(page.query, /after:/);
  assert.match(page.query, /before:/);
});

test('normal hourly scan uses short overlap while focused result scan uses a separate wider overlap', () => {
  const nowMs = Date.parse('2026-11-03T12:00:00Z');
  const last = nowMs - HOUR;
  const hourly = planGmailScanPage({ nowMs, lastSuccessfulAtMs: last });
  const results = planGmailScanPage({ nowMs, lastSuccessfulAtMs: last, scanType: 'results' });
  assert.equal(hourly.cursor.sinceMs, last - 15 * 60 * 1000);
  assert.equal(results.cursor.sinceMs, last - 6 * HOUR);
  assert.match(results.query, /抽選結果/);
  assert.doesNotMatch(results.query, /pokemoncenter-online/);
});

test('pagination keeps identical query bounds and advances the checkpoint only after the final page', () => {
  const first = planGmailScanPage({ nowMs: 100 * DAY, scanType: 'results' });
  const continuation = advanceGmailScanPage(first.cursor, { nextPageToken: 'opaque-next-page' });
  assert.equal(continuation.complete, false);
  assert.equal(continuation.lastSuccessfulAtMs, null);
  const next = planGmailScanPage({ nowMs: 101 * DAY, scanType: 'results', cursor: continuation.cursor });
  assert.equal(next.cursor.sinceMs, first.cursor.sinceMs);
  assert.equal(next.cursor.untilMs, first.cursor.untilMs);
  assert.equal(next.pageToken, 'opaque-next-page');
  assert.equal(next.query, first.query);
  const complete = advanceGmailScanPage(next.cursor);
  assert.equal(complete.complete, true);
  assert.equal(complete.cursor, null);
  assert.equal(complete.lastSuccessfulAtMs, first.cursor.untilMs);
});

test('invalid cursors and oversized Gmail pages fail closed', () => {
  const nowMs = Date.parse('2026-11-03T12:00:00Z');
  assert.throws(() => planGmailScanPage({ nowMs, maxResults: 101 }), /maxResults/);
  assert.throws(() => planGmailScanPage({ nowMs, cursor: { sinceMs: 10, untilMs: 5, scanType: 'hourly' } }), /cursor bounds/);
  assert.throws(() => planGmailScanPage({ nowMs, scanType: 'other' }), /scanType/);
});
