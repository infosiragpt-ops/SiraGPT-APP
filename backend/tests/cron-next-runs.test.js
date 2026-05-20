'use strict';

/**
 * Tests for utils/cron-next-runs — the schedule UI helper used by
 * GET /api/admin/system-cron/jobs (ratchet 44) to expand each job's
 * crontab expression into the next N upcoming run timestamps.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  nextRunsForJobs,
  nextRunsForSchedule,
  DEFAULT_COUNT,
  MAX_COUNT,
} = require('../src/utils/cron-next-runs');

const cronExpr = require('../src/utils/cron-expression');

describe('cron-next-runs.nextRunsForSchedule', () => {
  test('returns DEFAULT_COUNT (5) next runs for a daily schedule', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const runs = nextRunsForSchedule('30 2 * * *', undefined, from);
    assert.equal(runs.length, DEFAULT_COUNT);
    // cron-expression interprets fields in the host's local TZ, so we
    // compute the expected sequence with the same parser instead of
    // hard-coding UTC strings.
    const parsed = cronExpr.parseCron('30 2 * * *');
    let cursor = new Date(from);
    for (let i = 0; i < DEFAULT_COUNT; i++) {
      cursor = cronExpr.nextRun(parsed, cursor);
      assert.equal(runs[i], cursor.toISOString());
    }
  });

  test('honours the count argument (1..MAX_COUNT)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    assert.equal(nextRunsForSchedule('0 * * * *', 1, from).length, 1);
    assert.equal(nextRunsForSchedule('0 * * * *', 10, from).length, 10);
    // Clamped to MAX_COUNT.
    const big = nextRunsForSchedule('0 * * * *', MAX_COUNT + 50, from);
    assert.equal(big.length, MAX_COUNT);
  });

  test('returns strictly-increasing ISO timestamps', () => {
    const from = new Date('2026-03-15T12:34:56Z');
    const runs = nextRunsForSchedule('*/15 * * * *', 6, from);
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i] > runs[i - 1], `runs[${i}] should be after runs[${i - 1}]`);
    }
    // Each result must round-trip through Date.parse.
    runs.forEach((iso) => assert.ok(Number.isFinite(Date.parse(iso))));
  });

  test('returns [] for malformed cron expressions (no throw)', () => {
    assert.deepEqual(nextRunsForSchedule('not a cron', 3, new Date()), []);
    assert.deepEqual(nextRunsForSchedule('* * * *', 3, new Date()), []);
    assert.deepEqual(nextRunsForSchedule('99 * * * *', 3, new Date()), []);
  });

  test('returns [] for empty/non-string input', () => {
    assert.deepEqual(nextRunsForSchedule('', 3, new Date()), []);
    assert.deepEqual(nextRunsForSchedule(null, 3, new Date()), []);
    assert.deepEqual(nextRunsForSchedule(undefined, 3, new Date()), []);
    assert.deepEqual(nextRunsForSchedule(42, 3, new Date()), []);
  });

  test('default count falls back to 5 for non-positive / non-finite counts', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    assert.equal(nextRunsForSchedule('0 * * * *', 0, from).length, DEFAULT_COUNT);
    assert.equal(nextRunsForSchedule('0 * * * *', -3, from).length, DEFAULT_COUNT);
    assert.equal(nextRunsForSchedule('0 * * * *', NaN, from).length, DEFAULT_COUNT);
  });

  test('agrees with cron-expression.nextRun for the first element', () => {
    const from = new Date('2026-06-10T08:42:17Z');
    const runs = nextRunsForSchedule('15 7 * * *', 3, from);
    const expected = cronExpr.nextRun(cronExpr.parseCron('15 7 * * *'), from);
    assert.equal(runs[0], expected.toISOString());
  });
});

describe('cron-next-runs.nextRunsForJobs', () => {
  test('expands a system-cron status snapshot into name-keyed entries', () => {
    const snap = {
      enabled: true,
      tasks: [
        { name: 'scrub-deleted-user-content', schedule: '30 2 * * *' },
        { name: 'sweep-old-audit-archives', schedule: '15 7 * * *' },
      ],
    };
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs(snap, 5, from);
    assert.ok(out['scrub-deleted-user-content']);
    assert.ok(out['sweep-old-audit-archives']);
    assert.equal(out['scrub-deleted-user-content'].schedule, '30 2 * * *');
    assert.equal(out['scrub-deleted-user-content'].nextRuns.length, 5);
    // Compare against the same parser the helper uses (local-TZ-aware).
    const scrubExpected = cronExpr.nextRun(cronExpr.parseCron('30 2 * * *'), from);
    const sweepExpected = cronExpr.nextRun(cronExpr.parseCron('15 7 * * *'), from);
    assert.equal(out['scrub-deleted-user-content'].nextRuns[0], scrubExpected.toISOString());
    assert.equal(out['sweep-old-audit-archives'].nextRuns[0], sweepExpected.toISOString());
  });

  test('accepts a bare tasks array', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs([{ name: 'a', schedule: '0 * * * *' }], 3, from);
    assert.equal(out.a.nextRuns.length, 3);
  });

  test('accepts a `jobs` array (admin-response shape)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs({ jobs: [{ name: 'j1', schedule: '0 0 * * *' }] }, 2, from);
    assert.equal(out.j1.nextRuns.length, 2);
  });

  test('preserves input order via non-enumerable _jobs slot', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs({
      tasks: [
        { name: 'b', schedule: '0 0 * * *' },
        { name: 'a', schedule: '0 1 * * *' },
      ],
    }, 1, from);
    assert.ok(Array.isArray(out._jobs));
    assert.deepEqual(out._jobs.map((j) => j.name), ['b', 'a']);
    // _jobs must be non-enumerable so it doesn't pollute Object.keys().
    assert.ok(!Object.keys(out).includes('_jobs'));
  });

  test('handles malformed schedules per-job without throwing', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs({
      tasks: [
        { name: 'good', schedule: '0 * * * *' },
        { name: 'bad', schedule: 'totally invalid' },
        { name: 'empty', schedule: '' },
      ],
    }, 4, from);
    assert.equal(out.good.nextRuns.length, 4);
    assert.deepEqual(out.bad.nextRuns, []);
    assert.deepEqual(out.empty.nextRuns, []);
  });

  test('skips entries without a name or schedule (only _jobs records them)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs({
      tasks: [
        { schedule: '0 * * * *' }, // no name
        { name: 'no-schedule' },   // no schedule
        null,
        'not-an-object',
      ],
    }, 2, from);
    // Only un-named jobs are kept in _jobs, never in the by-name map.
    assert.equal(Object.keys(out).length, 1);
    assert.ok(out['no-schedule']);
    assert.deepEqual(out['no-schedule'].nextRuns, []);
    assert.ok(out._jobs.length >= 2);
  });

  test('returns {} (with empty _jobs) for empty / invalid input', () => {
    assert.deepEqual(nextRunsForJobs(null, 3)._jobs, []);
    assert.deepEqual(nextRunsForJobs(undefined, 3)._jobs, []);
    assert.deepEqual(nextRunsForJobs({}, 3)._jobs, []);
    assert.deepEqual(nextRunsForJobs({ tasks: [] }, 3)._jobs, []);
  });

  test('returns {schedule, nextRuns} when called with a cron string', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs('0 0 * * *', 3, from);
    assert.equal(out.schedule, '0 0 * * *');
    assert.equal(out.nextRuns.length, 3);
    const expected = cronExpr.nextRun(cronExpr.parseCron('0 0 * * *'), from);
    assert.equal(out.nextRuns[0], expected.toISOString());
  });

  test('defaults to DEFAULT_COUNT (5) when count omitted', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const out = nextRunsForJobs({ tasks: [{ name: 'x', schedule: '0 * * * *' }] }, undefined, from);
    assert.equal(out.x.nextRuns.length, DEFAULT_COUNT);
  });
});
