import test from 'node:test';
import assert from 'node:assert/strict';
import { getDueJobs } from '../src/schedule.js';

const atJst = (date, time) => new Date(`${date}T${time}:00+09:00`);

test('runs command queue on quarter-hour boundaries and nowhere else', () => {
  assert.deepEqual(getDueJobs(atJst('2026-11-03', '09:15')).map((job) => job.kind), ['command-queue']);
  assert.deepEqual(getDueJobs(atJst('2026-11-03', '09:14')).map((job) => job.kind), []);
});

test('polls Gmail hourly from 07:00 through 24:00 JST, including midnight', () => {
  const targetHours = [...Array.from({ length: 17 }, (_, index) => index + 7), 0];
  for (const hour of targetHours) {
    const time = `${String(hour).padStart(2, '0')}:00`;
    const jobs = getDueJobs(atJst('2026-11-03', time));
    assert.ok(jobs.some((job) => job.kind === 'gmail-lottery-inbox'), `expected Gmail poll at ${time}`);
  }
  for (const hour of [1, 2, 3, 4, 5, 6]) {
    const time = `${String(hour).padStart(2, '0')}:00`;
    const jobs = getDueJobs(atJst('2026-11-03', time));
    assert.ok(!jobs.some((job) => job.kind === 'gmail-lottery-inbox'), `unexpected Gmail poll at ${time}`);
  }
  assert.ok(!getDueJobs(atJst('2026-11-03', '07:30')).some((job) => job.kind === 'gmail-lottery-inbox'));
});

test('schedules focused lottery checks at 12:30 and 19:00 JST', () => {
  assert.ok(getDueJobs(atJst('2026-11-03', '12:30')).some((job) => job.kind === 'lottery-result-focus'));
  assert.ok(getDueJobs(atJst('2026-11-03', '19:00')).some((job) => job.kind === 'lottery-result-focus'));
  assert.ok(!getDueJobs(atJst('2026-11-03', '12:15')).some((job) => job.kind === 'lottery-result-focus'));
});

test('schedules one daily market refresh after 13:30 with a stable idempotency key', () => {
  const jobs = getDueJobs(atJst('2026-11-03', '13:45'));
  const market = jobs.filter((job) => job.kind === 'market-refresh');
  assert.equal(market.length, 1);
  assert.equal(market[0].jobKey, 'market-refresh:2026-11-03');
  assert.equal(getDueJobs(atJst('2026-11-03', '14:00')).filter((job) => job.kind === 'market-refresh').length, 1);
  assert.equal(getDueJobs(atJst('2026-11-03', '14:00'), { completedJobKeys: new Set(['market-refresh:2026-11-03']) })
    .some((job) => job.kind === 'market-refresh'), false);
});

test('separates queue, inbox, focus, and market jobs at shared dispatcher ticks', () => {
  const kinds = getDueJobs(atJst('2026-11-03', '19:00')).map((job) => job.kind);
  assert.deepEqual(kinds, ['command-queue', 'gmail-lottery-inbox', 'lottery-result-focus', 'market-refresh']);
  assert.equal(new Set(getDueJobs(atJst('2026-11-03', '19:00')).map((job) => job.jobKey)).size, kinds.length);
});

