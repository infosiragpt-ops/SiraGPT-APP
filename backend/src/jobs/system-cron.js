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

  const scrubTask = cron.schedule(
    SCRUB_SCHEDULE,
    async () => {
      if (scrubRunning) {
        logger.warn?.('[system-cron] skip scrub-deleted-user-content — previous run still active');
        return;
      }
      scrubRunning = true;
      try {
        // eslint-disable-next-line global-require
        const job = require('./scrub-deleted-user-content');
        const res = await job.run({ logger });
        logger.info?.(`[system-cron] scrub-deleted-user-content done: ${JSON.stringify(res)}`);
      } catch (err) {
        logger.error?.(`[system-cron] scrub-deleted-user-content failed: ${err && err.message}`);
      } finally {
        scrubRunning = false;
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'scrub-deleted-user-content', schedule: SCRUB_SCHEDULE, task: scrubTask });

  const hardDeleteTask = cron.schedule(
    HARD_DELETE_SCHEDULE,
    async () => {
      if (hardDeleteRunning) {
        logger.warn?.('[system-cron] skip hard-delete-deleted-users — previous run still active');
        return;
      }
      hardDeleteRunning = true;
      try {
        // eslint-disable-next-line global-require
        const job = require('./hard-delete-deleted-users');
        const res = await job.run({ logger });
        logger.info?.(`[system-cron] hard-delete-deleted-users done: ${JSON.stringify(res)}`);
      } catch (err) {
        logger.error?.(`[system-cron] hard-delete-deleted-users failed: ${err && err.message}`);
      } finally {
        hardDeleteRunning = false;
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'hard-delete-deleted-users', schedule: HARD_DELETE_SCHEDULE, task: hardDeleteTask });

  const apiUsagePruneTask = cron.schedule(
    APIUSAGE_PRUNE_SCHEDULE,
    async () => {
      if (apiUsagePruneRunning) {
        logger.warn?.('[system-cron] skip prune-api-usage — previous run still active');
        return;
      }
      apiUsagePruneRunning = true;
      try {
        // eslint-disable-next-line global-require
        const job = require('./prune-api-usage');
        const res = await job.run({ logger });
        logger.info?.(`[system-cron] prune-api-usage done: ${JSON.stringify(res)}`);
      } catch (err) {
        logger.error?.(`[system-cron] prune-api-usage failed: ${err && err.message}`);
      } finally {
        apiUsagePruneRunning = false;
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'prune-api-usage', schedule: APIUSAGE_PRUNE_SCHEDULE, task: apiUsagePruneTask });

  let sessionSweepRunning = false;
  const sessionSweepTask = cron.schedule(
    SESSION_SWEEP_SCHEDULE,
    async () => {
      if (sessionSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-sessions — previous run still active');
        return;
      }
      sessionSweepRunning = true;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-sessions');
        const res = await job.run({ logger });
        logger.info?.(`[system-cron] sweep-expired-sessions done: ${JSON.stringify(res)}`);
      } catch (err) {
        logger.error?.(`[system-cron] sweep-expired-sessions failed: ${err && err.message}`);
      } finally {
        sessionSweepRunning = false;
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-expired-sessions', schedule: SESSION_SWEEP_SCHEDULE, task: sessionSweepTask });

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
  return {
    enabled: true,
    tasks: _state.tasks.map((t) => ({ name: t.name, schedule: t.schedule })),
  };
}

module.exports = { start, stop, status, isEnabled };
