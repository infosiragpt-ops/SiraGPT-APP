/**
 * system-cron — internal cron registry for GDPR / housekeeping jobs.
 *
 * Wires the otherwise-orphan jobs from cycles 14 and 29 into the
 * Express process so the operator does not have to provision an
 * external cron runner. Two recurring jobs are scheduled in UTC:
 *
 *   02:30 UTC  scrub-deleted-user-content   (cycle 29)
 *   03:00 UTC  hard-delete-deleted-users    (cycle 14, runs after scrub)
 *
 * The 30-minute gap gives scrub time to finish before hard-delete
 * starts, so the audit logs and PII redaction are persisted before
 * the user row is removed.
 *
 * Disable with SYSTEM_CRON_ENABLED=false. Tests should keep that flag
 * unset (default off in test env) — see `start()` below.
 *
 * Concurrency: each job tracks its own in-flight flag to skip overlap
 * if a previous run is still going (very unlikely but defended).
 *
 * Failure isolation: handler errors are caught and logged — they
 * cannot crash the Express process.
 */

'use strict';

const { wrapWithRetry } = require('./job-utils');

const SCRUB_SCHEDULE = process.env.SYSTEM_CRON_SCRUB_SCHEDULE || '30 2 * * *';
const HARD_DELETE_SCHEDULE = process.env.SYSTEM_CRON_HARD_DELETE_SCHEDULE || '0 3 * * *';
// ApiUsage 90-day retention (docs/data-retention.md). Default 03:30 UTC so
// it runs after the hard-delete pass (the cascade can drop apiUsage rows
// owned by deleted users; the prune handles everything else).
const APIUSAGE_PRUNE_SCHEDULE = process.env.SYSTEM_CRON_APIUSAGE_PRUNE_SCHEDULE || '30 3 * * *';
// Session sweep — runs hourly (top of the hour) because `expiresAt` is
// a hard boundary and we don't want expired tokens lingering for a full
// day. See docs/data-retention.md (Session section).
const SESSION_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_SESSION_SWEEP_SCHEDULE || '0 * * * *';
// AuditLog 1-year online retention (docs/data-retention.md). Default
// 04:00 UTC so it runs after scrub (02:30) / hard-delete (03:00) /
// prune-api-usage (03:30) — the archive picks up any cascade-emitted
// audit events from the same nightly window.
const AUDIT_ARCHIVE_SCHEDULE = process.env.SYSTEM_CRON_AUDIT_ARCHIVE_SCHEDULE || '0 4 * * *';

let _state = null;

function isEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  const v = process.env.SYSTEM_CRON_ENABLED;
  if (v == null) return true;
  return String(v).toLowerCase() !== 'false';
}

function start(opts = {}) {
  if (_state) return _state;
  if (!isEnabled()) {
    return { enabled: false, tasks: [] };
  }
  const logger = opts.logger || console;
  let cron;
  try {
    // eslint-disable-next-line global-require
    cron = require('node-cron');
  } catch (err) {
    logger.warn?.(`[system-cron] node-cron not installed — system jobs disabled: ${err && err.message}`);
    return { enabled: false, tasks: [] };
  }

  const tasks = [];
  let scrubRunning = false;
  let hardDeleteRunning = false;
  let apiUsagePruneRunning = false;

  // Per-job telemetry (lastRun / lastDuration). Each entry pushed into
  // `tasks` carries its own `meta` object; the handler stamps timings
  // around every invocation so `/api/admin/health/services` can surface
  // them without coupling to cron internals.
  function recordRun(meta) {
    const startedAt = Date.now();
    return (err) => {
      const endedAt = Date.now();
      meta.lastRun = new Date(startedAt).toISOString();
      meta.lastDuration = endedAt - startedAt;
      meta.lastStatus = err ? 'error' : 'ok';
      if (err) meta.lastError = err && err.message ? err.message : String(err);
      else delete meta.lastError;
    };
  }

  const scrubMeta = {};
  const scrubTask = cron.schedule(
    SCRUB_SCHEDULE,
    async () => {
      if (scrubRunning) {
        logger.warn?.('[system-cron] skip scrub-deleted-user-content — previous run still active');
        return;
      }
      scrubRunning = true;
      const finish = recordRun(scrubMeta);
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./scrub-deleted-user-content');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] scrub-deleted-user-content retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] scrub-deleted-user-content done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] scrub-deleted-user-content failed: ${err && err.message}`);
      } finally {
        scrubRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'scrub-deleted-user-content', schedule: SCRUB_SCHEDULE, task: scrubTask, meta: scrubMeta });

  const hardDeleteMeta = {};
  const hardDeleteTask = cron.schedule(
    HARD_DELETE_SCHEDULE,
    async () => {
      if (hardDeleteRunning) {
        logger.warn?.('[system-cron] skip hard-delete-deleted-users — previous run still active');
        return;
      }
      hardDeleteRunning = true;
      const finish = recordRun(hardDeleteMeta);
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./hard-delete-deleted-users');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] hard-delete-deleted-users retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] hard-delete-deleted-users done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] hard-delete-deleted-users failed: ${err && err.message}`);
      } finally {
        hardDeleteRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'hard-delete-deleted-users', schedule: HARD_DELETE_SCHEDULE, task: hardDeleteTask, meta: hardDeleteMeta });

  const apiUsagePruneMeta = {};
  const apiUsagePruneTask = cron.schedule(
    APIUSAGE_PRUNE_SCHEDULE,
    async () => {
      if (apiUsagePruneRunning) {
        logger.warn?.('[system-cron] skip prune-api-usage — previous run still active');
        return;
      }
      apiUsagePruneRunning = true;
      const finish = recordRun(apiUsagePruneMeta);
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./prune-api-usage');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] prune-api-usage retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] prune-api-usage done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] prune-api-usage failed: ${err && err.message}`);
      } finally {
        apiUsagePruneRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'prune-api-usage', schedule: APIUSAGE_PRUNE_SCHEDULE, task: apiUsagePruneTask, meta: apiUsagePruneMeta });

  let auditArchiveRunning = false;
  const auditArchiveMeta = {};
  const auditArchiveTask = cron.schedule(
    AUDIT_ARCHIVE_SCHEDULE,
    async () => {
      if (auditArchiveRunning) {
        logger.warn?.('[system-cron] skip archive-audit-logs — previous run still active');
        return;
      }
      auditArchiveRunning = true;
      const finish = recordRun(auditArchiveMeta);
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./archive-audit-logs');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] archive-audit-logs retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] archive-audit-logs done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] archive-audit-logs failed: ${err && err.message}`);
      } finally {
        auditArchiveRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'archive-audit-logs', schedule: AUDIT_ARCHIVE_SCHEDULE, task: auditArchiveTask, meta: auditArchiveMeta });

  let sessionSweepRunning = false;
  const sessionSweepMeta = {};
  const sessionSweepTask = cron.schedule(
    SESSION_SWEEP_SCHEDULE,
    async () => {
      if (sessionSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-sessions — previous run still active');
        return;
      }
      sessionSweepRunning = true;
      const finish = recordRun(sessionSweepMeta);
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-sessions');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-expired-sessions retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-expired-sessions done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-expired-sessions failed: ${err && err.message}`);
      } finally {
        sessionSweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-expired-sessions', schedule: SESSION_SWEEP_SCHEDULE, task: sessionSweepTask, meta: sessionSweepMeta });

  for (const t of tasks) {
    try { t.task.start(); } catch (err) {
      logger.error?.(`[system-cron] failed to start ${t.name}: ${err && err.message}`);
    }
  }

  logger.info?.(`[system-cron] started ${tasks.length} job(s)`);
  _state = { enabled: true, tasks };
  return _state;
}

function stop() {
  if (!_state) return;
  for (const t of _state.tasks) {
    try { t.task.stop(); } catch (_) {}
  }
  _state = null;
}

function status() {
  if (!_state) return { enabled: false, tasks: [] };
  // Lazy-require cron-expression so the health probe can compute the
  // next deadline from each task's schedule. Parse failures are swallowed
  // (nextRun = null) so the probe never blocks the health endpoint.
  let cronExpr = null;
  try { cronExpr = require('../utils/cron-expression'); } catch (_) { /* optional */ }
  const now = new Date();
  return {
    enabled: true,
    tasks: _state.tasks.map((t) => {
      const meta = t.meta || {};
      let nextRun = null;
      if (cronExpr && typeof cronExpr.parseCron === 'function') {
        try {
          const parsed = cronExpr.parseCron(t.schedule);
          const next = cronExpr.nextRun(parsed, now);
          if (next instanceof Date) nextRun = next.toISOString();
        } catch (_) { /* malformed schedule — leave nextRun null */ }
      }
      return {
        name: t.name,
        schedule: t.schedule,
        lastRun: meta.lastRun || null,
        lastDuration: typeof meta.lastDuration === 'number' ? meta.lastDuration : null,
        lastStatus: meta.lastStatus || null,
        lastError: meta.lastError || null,
        nextRun,
      };
    }),
  };
}

module.exports = { start, stop, status, isEnabled };
