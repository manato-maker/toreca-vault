import test from 'node:test';
import assert from 'node:assert/strict';
import { getDueJobs } from '../src/schedule.js';

const atJst = (date, time) => new Date(`${date}T${time}:00+09:00`);

test('runs command queue on quarter-hour boundaries and nowhere else', () => {
  assert.deepEqual(getDueJobs(atJst('2026-11-03', '09:15')).map((job) => job.kind), ['command-queue', 'canonical-backup']);
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

test('keeps the 12:30 focus slot and recovers it after a missed Scheduler tick', () => {
  const original = getDueJobs(atJst('2026-11-03', '12:30'))
    .find((job) => job.kind === 'lottery-result-focus');
  assert.equal(original.jobKey, 'lottery-result-focus:2026-11-03');
  assert.equal(original.scheduledAt, '2026-11-03T12:30+09:00');
  assert.equal(original.catchUp, false);

  const recovered = getDueJobs(atJst('2026-11-03', '12:45'))
    .find((job) => job.kind === 'lottery-result-focus');
  assert.equal(recovered.jobKey, original.jobKey);
  assert.equal(recovered.scheduledAt, original.scheduledAt);
  assert.equal(recovered.catchUp, true);
  assert.equal(recovered.triggeredAt, atJst('2026-11-03', '12:45').toISOString());
});

test('stops retrying the daily focus after ledger success and merges 19:00 focus into Gmail', () => {
  const completed = new Set(['lottery-result-focus:2026-11-03']);
  assert.ok(!getDueJobs(atJst('2026-11-03', '13:00'), { completedJobKeys: completed })
    .some((job) => job.kind === 'lottery-result-focus'));

  const at1900 = getDueJobs(atJst('2026-11-03', '19:00'));
  assert.ok(at1900.some((job) => job.kind === 'gmail-lottery-inbox' && job.focusResults));
  assert.ok(!at1900.some((job) => job.kind === 'lottery-result-focus'));
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

test('runs one daily backup after 02:00 and catches up missed slots with a stable key', () => {
  assert.equal(getDueJobs(atJst('2026-11-03', '01:45')).some((job) => job.kind === 'canonical-backup'), false);
  const firstCatchUp = getDueJobs(atJst('2026-11-03', '02:15')).find((job) => job.kind === 'canonical-backup');
  assert.equal(firstCatchUp.jobKey, 'canonical-backup:2026-11-03');
  assert.equal(firstCatchUp.scheduledAt, '2026-11-03T02:00+09:00');
  assert.equal(getDueJobs(atJst('2026-11-03', '03:00')).find((job) => job.kind === 'canonical-backup').jobKey, firstCatchUp.jobKey);
  assert.equal(getDueJobs(atJst('2026-11-03', '03:00'), {
    completedJobKeys: new Set(['canonical-backup:2026-11-03'])
  }).some((job) => job.kind === 'canonical-backup'), false);
});

test('delayed execution uses the original scheduled slot for keys while recording actual time', () => {
  const actual = atJst('2026-11-03', '12:46');
  const scheduledAt = atJst('2026-11-03', '12:45');
  const jobs = getDueJobs(actual, { scheduledAt });
  const focus = jobs.find((job) => job.kind === 'lottery-result-focus');
  assert.equal(focus.scheduledAt, '2026-11-03T12:30+09:00');
  assert.equal(focus.catchUp, true);
  assert.equal(focus.triggeredAt, actual.toISOString());
});

test('19:00 combines result focus with the hourly Gmail job instead of scheduling a second scan', () => {
  const jobs = getDueJobs(atJst('2026-11-03', '19:00'));
  const gmail = jobs.filter((job) => job.kind === 'gmail-lottery-inbox');
  assert.equal(gmail.length, 1);
  assert.equal(gmail[0].focusResults, true);
  assert.equal(jobs.some((job) => job.kind === 'lottery-result-focus'), false);
  assert.deepEqual(jobs.map((job) => job.kind), ['command-queue', 'gmail-lottery-inbox', 'market-refresh', 'canonical-backup']);
});

