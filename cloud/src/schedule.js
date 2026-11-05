const TIME_ZONE = 'Asia/Tokyo';
const QUARTER_HOUR_MINUTES = new Set([0, 15, 30, 45]);

function jstParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function scheduledStamp(date, hour, minute) {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}+09:00`;
}

/**
 * Pure due-job planner for a Cloud Scheduler dispatcher configured every 15 minutes.
 * The caller must use the jobKey as an idempotency key in a durable ledger before
 * invoking any external worker. This function performs no I/O.
 */
export function getDueJobs(now, { completedJobKeys = new Set(), scheduledAt = now } = {}) {
  // Cloud Scheduler retries carry the original planned time. Use that slot even
  // when the HTTP handler starts late, so job keys and business windows stay stable.
  jstParts(now);
  const { date, hour, minute } = jstParts(scheduledAt);
  const due = [];

  if (QUARTER_HOUR_MINUTES.has(minute)) {
    const at = scheduledStamp(date, hour, minute);
    due.push({ kind: 'command-queue', jobKey: `command-queue:${at}`, scheduledAt: at });
  }

  // 24:00 in the requested JST schedule is the next calendar day's 00:00 tick.
  if ((hour === 0 || (hour >= 7 && hour <= 23)) && minute === 0) {
    const at = scheduledStamp(date, hour, minute);
    due.push({
      kind: 'gmail-lottery-inbox',
      jobKey: `gmail-lottery-inbox:${at}`,
      scheduledAt: at,
      ...(hour === 19 ? { focusResults: true } : {})
    });
  }

  // Keep the established 12:30 focused check. At 19:00 the focus flag is
  // folded into the hourly Gmail job above, avoiding a second Gmail execution.
  if (hour === 12 && minute === 30) {
    const at = scheduledStamp(date, hour, minute);
    due.push({ kind: 'lottery-result-focus', jobKey: `lottery-result-focus:${at}`, scheduledAt: at });
  }

  // First quarter-hour tick after 13:30. A durable success key keeps later
  // dispatcher ticks from repeating the daily market update.
  if (hour > 13 || (hour === 13 && minute >= 45)) {
    const jobKey = `market-refresh:${date}`;
    if (!completedJobKeys.has(jobKey)) {
      due.push({ kind: 'market-refresh', jobKey, scheduledAt: `${date}T13:45+09:00` });
    }
  }

  return due;
}

