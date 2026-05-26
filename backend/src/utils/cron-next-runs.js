'use strict';

/**
 * cron-next-runs — schedule UI helper that expands a system-cron status
 * snapshot (or a raw `{ tasks: [{ name, schedule }, ...] }` object, or a
 * single cron expression string) into the next N upcoming run timestamps
 * per registered job.
 *
 * Used by GET /api/admin/system-cron/jobs (ratchet 44) so the ops
 * dashboard can show a small "next runs" preview without re-running the
 * cron parser client-side.
 *
 * Inputs accepted by `nextRunsForJobs`:
 *   - the full snapshot returned by `jobs/system-cron.js#status()`
 *     i.e.  { enabled: bool, tasks: [{ name, schedule, ... }] }
 *   - a bare `{ tasks: [...] }` or `{ jobs: [...] }` object
 *   - an array of `{ name, schedule }` rows
 *   - a single cron expression string (returns `{ schedule, nextRuns }`)
 *
 * Outputs:
 *   - For snapshot/array input: an object keyed by job name with
 *     `{ schedule, nextRuns: [iso, iso, ...] }` values, plus a `_jobs`
 *     ordered array preserving the input order for callers that need it.
 *   - For string input: `{ schedule, nextRuns: [...] }`.
 *
 * Malformed cron expressions never throw — they yield `nextRuns: []` and
 * record the reason under `error`, mirroring the defensive behaviour of
 * `system-cron.status()` (it just leaves nextRun null when parsing fails).
 */

const cronExpr = require('./cron-expression');

const DEFAULT_COUNT = 5;
const MAX_COUNT = 100;

function _toJobsArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === 'object') {
    if (Array.isArray(input.tasks)) return input.tasks;
    if (Array.isArray(input.jobs)) return input.jobs;
  }
  return [];
}

function _normalizeCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNT;
  return Math.min(Math.floor(n), MAX_COUNT);
}

/**
 * Compute the next `count` strictly-greater-than-now run timestamps for
 * a single cron schedule string. Returns an array of ISO strings; on
 * parse/iterate failure returns `[]`.
 */
function nextRunsForSchedule(schedule, count = DEFAULT_COUNT, fromDate = new Date()) {
  const n = _normalizeCount(count);
  if (typeof schedule !== 'string' || !schedule.trim()) return [];
  let parsed;
  try {
    parsed = cronExpr.parseCron(schedule);
  } catch (_) {
    return [];
  }
  const out = [];
  let cursor = fromDate instanceof Date ? new Date(fromDate) : new Date();
  for (let i = 0; i < n; i++) {
    let next;
    try {
      next = cronExpr.nextRun(parsed, cursor);
    } catch (_) {
      break;
    }
    if (!(next instanceof Date) || Number.isNaN(next.getTime())) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

/**
 * Expand a `scheduleObject` (snapshot / array / string) into next-N run
 * times. See module header for accepted shapes.
 */
function nextRunsForJobs(scheduleObject, count = DEFAULT_COUNT, fromDate = new Date()) {
  const n = _normalizeCount(count);
  const now = fromDate instanceof Date ? fromDate : new Date();

  // String shortcut — single cron expression.
  if (typeof scheduleObject === 'string') {
    return { schedule: scheduleObject, nextRuns: nextRunsForSchedule(scheduleObject, n, now) };
  }

  const jobs = _toJobsArray(scheduleObject);
  const byName = {};
  const ordered = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const name = typeof job.name === 'string' && job.name ? job.name : null;
    const schedule = typeof job.schedule === 'string' ? job.schedule : null;
    const nextRuns = schedule ? nextRunsForSchedule(schedule, n, now) : [];
    const entry = { schedule, nextRuns };
    if (name) byName[name] = entry;
    ordered.push({ name, schedule, nextRuns });
  }
  // Non-enumerable `_jobs` lets callers preserve order without colliding
  // with any legitimate job named "_jobs".
  Object.defineProperty(byName, '_jobs', {
    value: ordered,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return byName;
}

module.exports = {
  nextRunsForJobs,
  nextRunsForSchedule,
  DEFAULT_COUNT,
  MAX_COUNT,
};
