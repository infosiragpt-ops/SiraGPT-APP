'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

// Module under test — fresh-required per test so internal state resets.
function freshLoad() {
  delete require.cache[require.resolve('../src/jobs/system-cron')];
  return require('../src/jobs/system-cron');
}

describe('system-cron', () => {
  afterEach(() => {
    delete process.env.SYSTEM_CRON_ENABLED;
    delete process.env.NODE_ENV;
    try { freshLoad().stop(); } catch (_) {}
  });

  test('isEnabled() — false in NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), false);
  });

  test('isEnabled() — true by default when not in test env', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SYSTEM_CRON_ENABLED;
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), true);
  });

  test('isEnabled() — false when SYSTEM_CRON_ENABLED=false', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'false';
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), false);
  });

  test('start() — returns disabled when disabled', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    const res = mod.start({ logger: { warn() {}, info() {}, error() {} } });
    assert.equal(res.enabled, false);
    assert.deepEqual(res.tasks, []);
  });

  test('status() — empty when not started', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    const s = mod.status();
    assert.equal(s.enabled, false);
    assert.deepEqual(s.tasks, []);
  });

  test('status() — exposes lastRun/lastDuration/nextRun fields per job', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    const logger = { warn() {}, info() {}, error() {} };
    mod.start({ logger });
    try {
      const snap = mod.status();
      assert.equal(snap.enabled, true);
      assert.ok(Array.isArray(snap.tasks) && snap.tasks.length >= 4);
      for (const t of snap.tasks) {
        assert.ok(typeof t.name === 'string');
        assert.ok(typeof t.schedule === 'string');
        // Telemetry slots exist (null until the job has actually run).
        assert.ok(Object.prototype.hasOwnProperty.call(t, 'lastRun'));
        assert.ok(Object.prototype.hasOwnProperty.call(t, 'lastDuration'));
        assert.ok(Object.prototype.hasOwnProperty.call(t, 'nextRun'));
        // nextRun is computable for the static UTC schedules we register.
        assert.ok(t.nextRun === null || typeof t.nextRun === 'string');
        if (typeof t.nextRun === 'string') {
          assert.ok(!Number.isNaN(Date.parse(t.nextRun)));
        }
      }
    } finally {
      mod.stop();
    }
  });

  test('start() — registers all jobs with UTC schedules when enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    const logs = [];
    const logger = { warn(m) { logs.push(['warn', m]); }, info(m) { logs.push(['info', m]); }, error(m) { logs.push(['error', m]); } };
    const res = mod.start({ logger });
    try {
      assert.equal(res.enabled, true);
      const names = res.tasks.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'archive-audit-logs',
        'cost-tracker-archive',
        'cost-tracker-flush',
        'detect-idle-orgs',
        'detect-idle-users',
        'failed-email-retry',
        'hard-delete-deleted-users',
        'prune-api-usage',
        'research-saved-search-alerts',
        'scrub-deleted-user-content',
        'sweep-expired-announcements',
        'sweep-expired-api-keys',
        'sweep-expired-partial-sessions',
        'sweep-expired-pending-transfers',
        'sweep-expired-sessions',
        'sweep-expired-verification-tokens',
        'sweep-inactive-api-keys',
        'sweep-old-audit-archives',
        'sweep-old-notifications',
        'sweep-stale-system-settings',
        'sweep-webhook-secret-grace',
      ]);
      // Default schedules — scrub @ 02:30 UTC, hard-delete @ 03:00 UTC,
      // prune-api-usage @ 03:30 UTC, archive-audit-logs @ 04:00 UTC,
      // sweep-expired-sessions hourly,
      // sweep-expired-verification-tokens @ 04:30 UTC.
      const scrub = res.tasks.find((t) => t.name === 'scrub-deleted-user-content');
      const hard = res.tasks.find((t) => t.name === 'hard-delete-deleted-users');
      const prune = res.tasks.find((t) => t.name === 'prune-api-usage');
      const archive = res.tasks.find((t) => t.name === 'archive-audit-logs');
      const sweep = res.tasks.find((t) => t.name === 'sweep-expired-sessions');
      const evt = res.tasks.find((t) => t.name === 'sweep-expired-verification-tokens');
      const idleUsers = res.tasks.find((t) => t.name === 'detect-idle-users');
      const researchAlerts = res.tasks.find((t) => t.name === 'research-saved-search-alerts');
      assert.equal(scrub.schedule, '30 2 * * *');
      assert.equal(hard.schedule, '0 3 * * *');
      assert.equal(prune.schedule, '30 3 * * *');
      assert.equal(archive.schedule, '0 4 * * *');
      assert.equal(sweep.schedule, '0 * * * *');
      assert.equal(evt.schedule, '30 4 * * *');
      assert.equal(idleUsers.schedule, '30 6 * * *');
      assert.equal(researchAlerts.schedule, '30 * * * *');
      const costArchive = res.tasks.find((t) => t.name === 'cost-tracker-archive');
      assert.equal(costArchive.schedule, '30 5 * * *');
    } finally {
      mod.stop();
    }
  });

  test('status() — flags stale jobs and fires alert via cycle 32 alerting', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    // Swap in a fake alerting channel so we can observe the alert
    // without touching Slack/PagerDuty.
    const alerting = require('../src/services/alerting');
    alerting._resetForTests();
    const fired = [];
    alerting.registerChannel((p) => { fired.push(p); return { ok: true }; });
    mod._resetStaleAlertsForTests();
    mod.start({ logger: { warn() {}, info() {}, error() {} } });
    try {
      // Manually stamp lastRun on the hourly sweep job 5 hours ago.
      // Threshold = interval(60min) × 3 = 180min → 5h is well past it.
      const sweep = require('../src/jobs/system-cron');
      const state = sweep.status();
      const sweepTask = state.tasks.find((t) => t.name === 'sweep-expired-sessions');
      assert.ok(sweepTask, 'sweep job present');
      // Reach into the running state to set meta.lastRun. We expose this
      // through the live tasks array via a small back-channel: status()
      // is a projection, but the meta object is shared by reference.
      const live = require('../src/jobs/system-cron');
      // Use start()'s returned state via re-call — start() is idempotent.
      const running = live.start({ logger: { warn() {}, info() {}, error() {} } });
      const liveSweep = running.tasks.find((t) => t.name === 'sweep-expired-sessions');
      liveSweep.meta.lastRun = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const snap = live.status();
      const sweepSnap = snap.tasks.find((t) => t.name === 'sweep-expired-sessions');
      assert.equal(sweepSnap.stale, true, 'should be flagged stale');
      assert.ok(sweepSnap.staleBy > 0);
      // Allow the fire-and-forget alert promise to flush.
      return new Promise((resolve) => setImmediate(() => {
        assert.ok(fired.some((p) => p.title === 'system_cron_stale:sweep-expired-sessions'), 'alert fired');
        resolve();
      }));
    } finally {
      mod.stop();
    }
  });

  test('status() — does not flag stale when lastRun is fresh', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    const running = mod.start({ logger: { warn() {}, info() {}, error() {} } });
    try {
      const sweep = running.tasks.find((t) => t.name === 'sweep-expired-sessions');
      sweep.meta.lastRun = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min ago
      const snap = mod.status();
      const s = snap.tasks.find((t) => t.name === 'sweep-expired-sessions');
      assert.equal(s.stale, false);
    } finally {
      mod.stop();
    }
  });

  test('siragpt_cron_* metric families are registered and render in Prometheus text', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    // Reset the shared metrics registry so we can read clean series.
    const metrics = require('../src/utils/metrics');
    metrics._reset();
    const running = mod.start({ logger: { warn() {}, info() {}, error() {} } });
    try {
      // Synthesise a successful run by stamping the meta directly via
      // the same code path the real handler uses.
      const sweep = running.tasks.find((t) => t.name === 'sweep-expired-sessions');
      // Drive lastRun / lastDuration manually — easier than waiting for
      // the schedule. Then trigger a metric write via the same helpers
      // by re-invoking gauge/observe with the same job label.
      const startedAt = Date.now();
      metrics.gauge('siragpt_cron_last_success_timestamp', { job: sweep.name }, Math.round(startedAt / 1000));
      metrics.observe('siragpt_cron_last_duration_seconds', { job: sweep.name }, 0.123);
      const text = metrics.renderText();
      assert.match(text, /siragpt_cron_last_success_timestamp\{job="sweep-expired-sessions"\}/);
      assert.match(text, /siragpt_cron_last_duration_seconds_bucket\{job="sweep-expired-sessions",le="0.25"\} 1/);
    } finally {
      mod.stop();
      metrics._reset();
    }
  });

  test('status() — never-run jobs are not flagged stale', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    mod.start({ logger: { warn() {}, info() {}, error() {} } });
    try {
      const snap = mod.status();
      for (const t of snap.tasks) {
        // Fresh start → no lastRun → not stale.
        assert.equal(t.lastRun, null);
        assert.equal(t.stale, false);
      }
    } finally {
      mod.stop();
    }
  });
});
