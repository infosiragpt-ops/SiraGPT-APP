/**
 * system-cron — internal cron registry for GDPR / housekeeping jobs.
 *
 * Wires the otherwise-orphan jobs from cycles 14 and 29 into the
 * Express process so the operator does not have to provision an
 * external cron runner. Two recurring jobs are scheduled in UTC:
 *
 *   02:30 UTC  scrub-deleted-user-content   (cycle 29)
 *   03:00 UTC  hard-delete-deleted-users    (cycle 14, runs after scrub)
 *   04:30 UTC  sweep-expired-verification-tokens (30d retention)
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
// EmailVerificationToken 30-day retention. Default 04:30 UTC so it runs
// after the audit archive (04:00) — the cascade from any user deletions
// has already been picked up by then.
const EVT_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_EVT_SWEEP_SCHEDULE || '30 4 * * *';
// Ratchet 45 — OrgAnnouncement expiry sweep. Default 04:15 UTC, sitting
// between the audit archive (04:00) and the EVT sweep (04:30). Cheap
// deleteMany — hard-deletes announcements whose `expiresAt` is in the
// past (pinned rows with expiresAt = null are left untouched).
const ANNOUNCEMENT_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_ANNOUNCEMENT_SWEEP_SCHEDULE || '15 4 * * *';
// Ratchet 45 — ApiKey expiry sweep. Default 04:45 UTC, right after the
// EVT sweep (04:30). Hard-deletes rows whose `expiresAt` is in the past
// (auth middleware already rejects them; no need to keep the rows).
const API_KEY_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_API_KEY_SWEEP_SCHEDULE || '45 4 * * *';
// Ratchet 45 — flush in-process cost-tracker into the CostUsageDaily
// table. Default 05:00 UTC so it runs after every other retention job;
// reports older than 24h are served from this table.
const COST_FLUSH_SCHEDULE = process.env.SYSTEM_CRON_COST_FLUSH_SCHEDULE || '0 5 * * *';
// Ratchet 45 — archive CostUsageDaily rows older than 13 months into
// SystemSettings `cost_archive:YYYY-MM-<userId>` blobs and delete the
// daily rows. Default 05:30 UTC so it runs right after the daily flush.
const COST_ARCHIVE_SCHEDULE = process.env.SYSTEM_CRON_COST_ARCHIVE_SCHEDULE || '30 5 * * *';
// Ratchet 45 (Task 1) — clear elapsed rotate-secret grace windows on
// WebhookEndpoint rows. Default 05:15 UTC, after the audit archive
// (04:00) and cost flush (05:00) so we don't contend with the heavier
// passes. Cheap one-statement updateMany.
const WEBHOOK_SECRET_GRACE_SCHEDULE = process.env.SYSTEM_CRON_WEBHOOK_SECRET_GRACE_SCHEDULE || '15 5 * * *';
// Ratchet 45 (Task 2) — hard-delete ApiKey rows whose lastUsedAt is
// older than the inactivity threshold (default 180d). Default 05:45
// UTC, right after the cost-archive (05:30).
const INACTIVE_API_KEY_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_INACTIVE_API_KEY_SWEEP_SCHEDULE || '45 5 * * *';
// Ratchet 45 — drain the failed-email retry queue (critical emails:
// org-invitation welcome + verification magic link). Default 06:00
// UTC so it runs after every retention/cleanup pass; each pass walks
// SystemSettings `failed_email_retry:*` rows and re-attempts delivery
// up to MAX_ATTEMPTS times before dropping.
const FAILED_EMAIL_RETRY_SCHEDULE = process.env.SYSTEM_CRON_FAILED_EMAIL_RETRY_SCHEDULE || '0 6 * * *';
// Ratchet 45 — Notification inbox retention sweep. Default 04:45 UTC,
// piggy-backing on the ApiKey expiry slot (independent tables, cheap
// deleteMany — they can co-fire). Hard-deletes rows that are
// (read AND readAt < now-30d) OR (unread AND createdAt < now-90d).
const NOTIFICATION_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_NOTIFICATION_SWEEP_SCHEDULE || '45 4 * * *';
// Ratchet 45 — PartialSession (TOTP/SMS handoff) retention sweep.
// PartialSession rows have a 5-minute TTL and are single-use; this
// sweep hard-deletes expired rows plus consumed rows older than 1h.
// Default `5 * * * *` (every hour at :05) — sits 5 minutes after the
// session sweep at :00 so the two hourly passes don't co-fire.
const PARTIAL_SESSION_SWEEP_SCHEDULE = process.env.SYSTEM_CRON_PARTIAL_SESSION_SWEEP_SCHEDULE || '5 * * * *';
// Ratchet 45 — daily org idleness detector. Default 06:00 UTC; co-fires
// with the failed-email retry queue (different tables, no contention).
// Walks every Organization, flags those with no member activity in the
// last 60d into SystemSettings `org_idle:<orgId>`.
const DETECT_IDLE_ORGS_SCHEDULE = process.env.SYSTEM_CRON_DETECT_IDLE_ORGS_SCHEDULE || '0 6 * * *';

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

  // Lazy-loaded metrics handle — instrumentation must never break cron
  // execution, so we swallow load errors and degrade to a no-op.
  let _metrics = null;
  function _getMetrics() {
    if (_metrics !== null) return _metrics || null;
    try {
      // eslint-disable-next-line global-require
      _metrics = require('../utils/metrics');
    } catch (_) {
      _metrics = false; // sentinel: tried + failed
    }
    return _metrics || null;
  }

  // Per-job telemetry (lastRun / lastDuration). Each entry pushed into
  // `tasks` carries its own `meta` object; the handler stamps timings
  // around every invocation so `/api/admin/health/services` can surface
  // them without coupling to cron internals.
  //
  // Ratchet 45 also emits Prometheus-shape metrics on each successful
  // run:
  //   siragpt_cron_last_success_timestamp{job}  — epoch seconds gauge
  //   siragpt_cron_last_duration_seconds{job}   — duration histogram
  // Failures intentionally skip the success-timestamp gauge so stale
  // alerts continue to fire when a job is broken; duration is still
  // observed (the histogram is useful even for failed runs).
  function recordRun(meta, jobName) {
    const startedAt = Date.now();
    return (err) => {
      const endedAt = Date.now();
      const durationMs = endedAt - startedAt;
      meta.lastRun = new Date(startedAt).toISOString();
      meta.lastDuration = durationMs;
      meta.lastStatus = err ? 'error' : 'ok';
      if (err) meta.lastError = err && err.message ? err.message : String(err);
      else delete meta.lastError;
      const metrics = _getMetrics();
      if (metrics && jobName) {
        const durationSec = durationMs / 1000;
        try {
          if (!err && typeof metrics.gauge === 'function') {
            metrics.gauge('siragpt_cron_last_success_timestamp', { job: jobName }, Math.round(endedAt / 1000));
          }
          if (typeof metrics.observe === 'function' && Number.isFinite(durationSec) && durationSec >= 0) {
            metrics.observe('siragpt_cron_last_duration_seconds', { job: jobName }, durationSec);
          }
        } catch (_) {
          // never throw from instrumentation
        }
      }
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
      const finish = recordRun(scrubMeta, 'scrub-deleted-user-content');
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
      const finish = recordRun(hardDeleteMeta, 'hard-delete-deleted-users');
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
      const finish = recordRun(apiUsagePruneMeta, 'prune-api-usage');
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
      const finish = recordRun(auditArchiveMeta, 'archive-audit-logs');
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
      const finish = recordRun(sessionSweepMeta, 'sweep-expired-sessions');
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

  let evtSweepRunning = false;
  const evtSweepMeta = {};
  const evtSweepTask = cron.schedule(
    EVT_SWEEP_SCHEDULE,
    async () => {
      if (evtSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-verification-tokens — previous run still active');
        return;
      }
      evtSweepRunning = true;
      const finish = recordRun(evtSweepMeta, 'sweep-expired-verification-tokens');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-verification-tokens');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-expired-verification-tokens retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-expired-verification-tokens done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-expired-verification-tokens failed: ${err && err.message}`);
      } finally {
        evtSweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-expired-verification-tokens', schedule: EVT_SWEEP_SCHEDULE, task: evtSweepTask, meta: evtSweepMeta });

  // Ratchet 45 — OrgAnnouncement expiry sweep.
  let announcementSweepRunning = false;
  const announcementSweepMeta = {};
  const announcementSweepTask = cron.schedule(
    ANNOUNCEMENT_SWEEP_SCHEDULE,
    async () => {
      if (announcementSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-announcements — previous run still active');
        return;
      }
      announcementSweepRunning = true;
      const finish = recordRun(announcementSweepMeta, 'sweep-expired-announcements');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-announcements');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-expired-announcements retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-expired-announcements done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-expired-announcements failed: ${err && err.message}`);
      } finally {
        announcementSweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-expired-announcements', schedule: ANNOUNCEMENT_SWEEP_SCHEDULE, task: announcementSweepTask, meta: announcementSweepMeta });

  // Ratchet 45 — ApiKey expiry sweep.
  let apiKeySweepRunning = false;
  const apiKeySweepMeta = {};
  const apiKeySweepTask = cron.schedule(
    API_KEY_SWEEP_SCHEDULE,
    async () => {
      if (apiKeySweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-api-keys — previous run still active');
        return;
      }
      apiKeySweepRunning = true;
      const finish = recordRun(apiKeySweepMeta, 'sweep-expired-api-keys');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-api-keys');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-expired-api-keys retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-expired-api-keys done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-expired-api-keys failed: ${err && err.message}`);
      } finally {
        apiKeySweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-expired-api-keys', schedule: API_KEY_SWEEP_SCHEDULE, task: apiKeySweepTask, meta: apiKeySweepMeta });

  // Ratchet 45 — persist AI cost-tracker into CostUsageDaily.
  let costFlushRunning = false;
  const costFlushMeta = {};
  const costFlushTask = cron.schedule(
    COST_FLUSH_SCHEDULE,
    async () => {
      if (costFlushRunning) {
        logger.warn?.('[system-cron] skip cost-tracker-flush — previous run still active');
        return;
      }
      costFlushRunning = true;
      const finish = recordRun(costFlushMeta, 'cost-tracker-flush');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const costTracker = require('../services/ai/cost-tracker');
        const runWithRetry = wrapWithRetry(() => costTracker.flushDaily(), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] cost-tracker-flush retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] cost-tracker-flush done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] cost-tracker-flush failed: ${err && err.message}`);
      } finally {
        costFlushRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'cost-tracker-flush', schedule: COST_FLUSH_SCHEDULE, task: costFlushTask, meta: costFlushMeta });

  // Ratchet 45 — 13-month archive of CostUsageDaily into SystemSettings.
  let costArchiveRunning = false;
  const costArchiveMeta = {};
  const costArchiveTask = cron.schedule(
    COST_ARCHIVE_SCHEDULE,
    async () => {
      if (costArchiveRunning) {
        logger.warn?.('[system-cron] skip cost-tracker-archive — previous run still active');
        return;
      }
      costArchiveRunning = true;
      const finish = recordRun(costArchiveMeta, 'cost-tracker-archive');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const costTracker = require('../services/ai/cost-tracker');
        const runWithRetry = wrapWithRetry(() => costTracker.archiveOldDaily(), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] cost-tracker-archive retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] cost-tracker-archive done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] cost-tracker-archive failed: ${err && err.message}`);
      } finally {
        costArchiveRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'cost-tracker-archive', schedule: COST_ARCHIVE_SCHEDULE, task: costArchiveTask, meta: costArchiveMeta });

  // Ratchet 45 (Task 1) — WebhookEndpoint grace-secret cleanup.
  let webhookSecretGraceRunning = false;
  const webhookSecretGraceMeta = {};
  const webhookSecretGraceTask = cron.schedule(
    WEBHOOK_SECRET_GRACE_SCHEDULE,
    async () => {
      if (webhookSecretGraceRunning) {
        logger.warn?.('[system-cron] skip sweep-webhook-secret-grace — previous run still active');
        return;
      }
      webhookSecretGraceRunning = true;
      const finish = recordRun(webhookSecretGraceMeta, 'sweep-webhook-secret-grace');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-webhook-secret-grace');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-webhook-secret-grace retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-webhook-secret-grace done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-webhook-secret-grace failed: ${err && err.message}`);
      } finally {
        webhookSecretGraceRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-webhook-secret-grace', schedule: WEBHOOK_SECRET_GRACE_SCHEDULE, task: webhookSecretGraceTask, meta: webhookSecretGraceMeta });

  // Ratchet 45 (Task 2) — inactive ApiKey cleanup.
  let inactiveApiKeySweepRunning = false;
  const inactiveApiKeySweepMeta = {};
  const inactiveApiKeySweepTask = cron.schedule(
    INACTIVE_API_KEY_SWEEP_SCHEDULE,
    async () => {
      if (inactiveApiKeySweepRunning) {
        logger.warn?.('[system-cron] skip sweep-inactive-api-keys — previous run still active');
        return;
      }
      inactiveApiKeySweepRunning = true;
      const finish = recordRun(inactiveApiKeySweepMeta, 'sweep-inactive-api-keys');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-inactive-api-keys');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-inactive-api-keys retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-inactive-api-keys done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-inactive-api-keys failed: ${err && err.message}`);
      } finally {
        inactiveApiKeySweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({ name: 'sweep-inactive-api-keys', schedule: INACTIVE_API_KEY_SWEEP_SCHEDULE, task: inactiveApiKeySweepTask, meta: inactiveApiKeySweepMeta });

  // Ratchet 45 — Notification inbox retention sweep.
  let notificationSweepRunning = false;
  const notificationSweepMeta = {};
  const notificationSweepTask = cron.schedule(
    NOTIFICATION_SWEEP_SCHEDULE,
    async () => {
      if (notificationSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-old-notifications — previous run still active');
        return;
      }
      notificationSweepRunning = true;
      const finish = recordRun(notificationSweepMeta, 'sweep-old-notifications');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-old-notifications');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-old-notifications retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-old-notifications done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-old-notifications failed: ${err && err.message}`);
      } finally {
        notificationSweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({
    name: 'sweep-old-notifications',
    schedule: NOTIFICATION_SWEEP_SCHEDULE,
    task: notificationSweepTask,
    meta: notificationSweepMeta,
  });

  // Ratchet 45 — failed-email retry queue drain (06:00 UTC).
  let failedEmailRetryRunning = false;
  const failedEmailRetryMeta = {};
  const failedEmailRetryTask = cron.schedule(
    FAILED_EMAIL_RETRY_SCHEDULE,
    async () => {
      if (failedEmailRetryRunning) {
        logger.warn?.('[system-cron] skip failed-email-retry — previous run still active');
        return;
      }
      failedEmailRetryRunning = true;
      const finish = recordRun(failedEmailRetryMeta, 'failed-email-retry');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('../services/failed-email-retry');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] failed-email-retry retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] failed-email-retry done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] failed-email-retry failed: ${err && err.message}`);
      } finally {
        failedEmailRetryRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({
    name: 'failed-email-retry',
    schedule: FAILED_EMAIL_RETRY_SCHEDULE,
    task: failedEmailRetryTask,
    meta: failedEmailRetryMeta,
  });

  // Ratchet 45 — PartialSession expiry sweep (hourly).
  let partialSessionSweepRunning = false;
  const partialSessionSweepMeta = {};
  const partialSessionSweepTask = cron.schedule(
    PARTIAL_SESSION_SWEEP_SCHEDULE,
    async () => {
      if (partialSessionSweepRunning) {
        logger.warn?.('[system-cron] skip sweep-expired-partial-sessions — previous run still active');
        return;
      }
      partialSessionSweepRunning = true;
      const finish = recordRun(partialSessionSweepMeta, 'sweep-expired-partial-sessions');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./sweep-expired-partial-sessions');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] sweep-expired-partial-sessions retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] sweep-expired-partial-sessions done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] sweep-expired-partial-sessions failed: ${err && err.message}`);
      } finally {
        partialSessionSweepRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({
    name: 'sweep-expired-partial-sessions',
    schedule: PARTIAL_SESSION_SWEEP_SCHEDULE,
    task: partialSessionSweepTask,
    meta: partialSessionSweepMeta,
  });

  // Ratchet 45 — daily idle-org detector (06:00 UTC).
  let detectIdleOrgsRunning = false;
  const detectIdleOrgsMeta = {};
  const detectIdleOrgsTask = cron.schedule(
    DETECT_IDLE_ORGS_SCHEDULE,
    async () => {
      if (detectIdleOrgsRunning) {
        logger.warn?.('[system-cron] skip detect-idle-orgs — previous run still active');
        return;
      }
      detectIdleOrgsRunning = true;
      const finish = recordRun(detectIdleOrgsMeta, 'detect-idle-orgs');
      let runErr = null;
      try {
        // eslint-disable-next-line global-require
        const job = require('./detect-idle-orgs');
        const runWithRetry = wrapWithRetry(() => job.run({ logger }), {
          onRetry: ({ attempt, delayMs, reason }) =>
            logger.warn?.(`[system-cron] detect-idle-orgs retry ${attempt} in ${delayMs}ms (${reason})`),
        });
        const res = await runWithRetry();
        logger.info?.(`[system-cron] detect-idle-orgs done: ${JSON.stringify(res)}`);
      } catch (err) {
        runErr = err;
        logger.error?.(`[system-cron] detect-idle-orgs failed: ${err && err.message}`);
      } finally {
        detectIdleOrgsRunning = false;
        finish(runErr);
      }
    },
    { scheduled: false, timezone: 'UTC' },
  );
  tasks.push({
    name: 'detect-idle-orgs',
    schedule: DETECT_IDLE_ORGS_SCHEDULE,
    task: detectIdleOrgsTask,
    meta: detectIdleOrgsMeta,
  });

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

// Track titles we've already alerted on this status() pass so a single
// snapshot doesn't double-fire (the cycle 32 alerting layer also dedups
// by title, but that's a 5-minute window — this avoids duplicate POSTs
// when status() is hit by multiple health probes in the same tick).
const _staleAlertSent = new Map(); // name → lastAlertAt (ms)
const STALE_ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between re-alerts per job

function _stalenessMultiplier() {
  const v = Number.parseInt(process.env.SYSTEM_CRON_STALE_MULTIPLIER || '3', 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/**
 * Compute the schedule interval in ms from a parsed cron expression by
 * sampling the gap between two consecutive runs starting at `from`.
 * Returns `null` when the gap can't be determined (e.g. malformed expr).
 */
function _scheduleIntervalMs(cronExpr, schedule, from) {
  try {
    const parsed = cronExpr.parseCron(schedule);
    const a = cronExpr.nextRun(parsed, from);
    const b = cronExpr.nextRun(parsed, a);
    if (a instanceof Date && b instanceof Date) {
      const delta = b.getTime() - a.getTime();
      return delta > 0 ? delta : null;
    }
  } catch (_) { /* malformed — caller handles null */ }
  return null;
}

function status() {
  if (!_state) return { enabled: false, tasks: [] };
  // Lazy-require cron-expression so the health probe can compute the
  // next deadline from each task's schedule. Parse failures are swallowed
  // (nextRun = null) so the probe never blocks the health endpoint.
  let cronExpr = null;
  try { cronExpr = require('../utils/cron-expression'); } catch (_) { /* optional */ }
  // Lazy-require alerting (cycle 32) so test envs without the alerting
  // module wired up don't blow up the probe.
  let alerting = null;
  try { alerting = require('../services/alerting'); } catch (_) { /* optional */ }

  const now = new Date();
  const multiplier = _stalenessMultiplier();
  return {
    enabled: true,
    tasks: _state.tasks.map((t) => {
      const meta = t.meta || {};
      let nextRun = null;
      let intervalMs = null;
      if (cronExpr && typeof cronExpr.parseCron === 'function') {
        try {
          const parsed = cronExpr.parseCron(t.schedule);
          const next = cronExpr.nextRun(parsed, now);
          if (next instanceof Date) nextRun = next.toISOString();
        } catch (_) { /* malformed schedule — leave nextRun null */ }
        intervalMs = _scheduleIntervalMs(cronExpr, t.schedule, now);
      }

      // Staleness check — only when we know lastRun *and* can compute
      // the schedule interval. A job that's never run is not "stale",
      // it's just freshly registered.
      let stale = false;
      let staleBy = null;
      if (meta.lastRun && intervalMs) {
        const lastMs = Date.parse(meta.lastRun);
        if (Number.isFinite(lastMs)) {
          const ageMs = now.getTime() - lastMs;
          const threshold = intervalMs * multiplier;
          if (ageMs > threshold) {
            stale = true;
            staleBy = ageMs - threshold;
            // Fire-and-forget alert via cycle 32 alerting. Cooldown
            // suppresses repeats within STALE_ALERT_COOLDOWN_MS.
            if (alerting && typeof alerting.sendAlert === 'function') {
              const last = _staleAlertSent.get(t.name) || 0;
              if (now.getTime() - last >= STALE_ALERT_COOLDOWN_MS) {
                _staleAlertSent.set(t.name, now.getTime());
                try {
                  Promise.resolve(alerting.sendAlert({
                    title: `system_cron_stale:${t.name}`,
                    message: `Cron "${t.name}" lastRun is ${Math.round(ageMs / 60000)}m old `
                      + `(threshold ${Math.round(threshold / 60000)}m = interval × ${multiplier})`,
                    severity: 'error',
                    context: {
                      job: t.name,
                      schedule: t.schedule,
                      lastRun: meta.lastRun,
                      ageMs,
                      intervalMs,
                      thresholdMs: threshold,
                      multiplier,
                    },
                  })).catch(() => { /* never throw from probe */ });
                } catch (_) { /* never throw */ }
              }
            }
          }
        }
      }

      return {
        name: t.name,
        schedule: t.schedule,
        lastRun: meta.lastRun || null,
        lastDuration: typeof meta.lastDuration === 'number' ? meta.lastDuration : null,
        lastStatus: meta.lastStatus || null,
        lastError: meta.lastError || null,
        nextRun,
        intervalMs,
        stale,
        staleBy,
      };
    }),
  };
}

function _resetStaleAlertsForTests() {
  _staleAlertSent.clear();
}

module.exports = { start, stop, status, isEnabled, _resetStaleAlertsForTests };
