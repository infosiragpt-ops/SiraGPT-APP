'use strict';

/**
 * goal-cleanup — retention sweeper for terminal `GoalRun` rows.
 *
 * Mirrors the shape of `services/goal-boot-recovery.js` (run-once at
 * boot, idempotent, fire-and-forget, never throws out) but with a
 * different mandate: delete `goal_runs` rows whose status is terminal
 * (`completed | failed | cancelled`) AND whose `updatedAt` is older
 * than `GOAL_CLEANUP_RETENTION_MS` (default 30 days).
 *
 * The `goal_run_events.goalRunId` foreign-key cascade takes the events
 * with it — no separate delete needed.
 *
 * Why a sweeper instead of a TTL? Postgres has no TTL primitive; a
 * Prisma scheduled task would be overkill for the cardinality we're
 * looking at (low thousands of terminal rows per month). One-shot
 * `deleteMany` from a periodic interval is the right pressure point.
 *
 * Both the boot pass and the interval pass call the same
 * `runGoalCleanupSweep` helper; the function MUST NOT throw out of
 * either entry point — a DB blip during the sweep is logged and the
 * pass returns zero counts plus an `error` field.
 *
 * Env knobs:
 *   - GOAL_CLEANUP_RETENTION_MS  default 30 * 24 * 60 * 60 * 1000 (30 days)
 *   - GOAL_CLEANUP_INTERVAL_MS   default 60 * 60 * 1000 (1 hour)
 *   - GOAL_CLEANUP_ENABLED       default truthy; set to `0`/`false` to
 *                                disable entirely (long retention for audit).
 */

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;              // 1 hour

let prismaModule = null;
function getPrisma() {
  if (prismaModule !== null) return prismaModule;
  try {
    // eslint-disable-next-line global-require
    prismaModule = require('../config/database');
  } catch {
    prismaModule = false;
  }
  return prismaModule;
}

function logInfo(logger, fields, message) {
  if (logger && typeof logger.info === 'function') logger.info(fields, message);
}
function logWarn(logger, fields, message) {
  if (logger && typeof logger.warn === 'function') logger.warn(fields, message);
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Parse the GOAL_CLEANUP_ENABLED env var. Truthy by default. The
 * conservative interpretation: only the explicit strings `0`, `false`,
 * `off`, `no` (case-insensitive) disable cleanup. Anything else
 * (including empty/unset) leaves cleanup ON, matching the principle
 * that retention should default to bounded for sensible disk usage.
 */
function isCleanupEnabled(env = process.env) {
  const raw = env.GOAL_CLEANUP_ENABLED;
  if (raw == null || raw === '') return true;
  const normalised = String(raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalised);
}

function readConfig(env = process.env) {
  return {
    retentionMs: parseNonNegativeInt(
      env.GOAL_CLEANUP_RETENTION_MS,
      DEFAULT_RETENTION_MS,
    ),
    intervalMs: parseNonNegativeInt(
      env.GOAL_CLEANUP_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    enabled: isCleanupEnabled(env),
  };
}

function hasModel(prisma, name) {
  return Boolean(prisma && prisma[name]);
}

/**
 * Delete terminal goal_runs older than the retention cutoff. Returns
 * `{ deleted, scanned, durationMs }`. `scanned` mirrors `deleted` since
 * deleteMany is a single bulk op — there's no separate scan step.
 *
 * On any Prisma error we return `{ deleted: 0, scanned: 0, durationMs,
 * error }` rather than throwing — the caller (boot path + interval)
 * must never crash out of a transient DB blip.
 */
async function runGoalCleanupSweep({ logger, env = process.env } = {}) {
  const startedAt = Date.now();
  const config = readConfig(env);

  const prisma = getPrisma();
  if (!prisma) {
    return {
      deleted: 0,
      scanned: 0,
      durationMs: Date.now() - startedAt,
      skipped: true,
      reason: 'prisma_unavailable',
    };
  }
  if (!hasModel(prisma, 'goalRun')) {
    return {
      deleted: 0,
      scanned: 0,
      durationMs: Date.now() - startedAt,
      skipped: true,
      reason: 'model_missing',
    };
  }

  const cutoff = new Date(Date.now() - config.retentionMs);
  try {
    const result = await prisma.goalRun.deleteMany({
      where: {
        status: { in: ['completed', 'failed', 'cancelled'] },
        updatedAt: { lt: cutoff },
      },
    });
    const deleted = Number(result?.count || 0);
    return {
      deleted,
      scanned: deleted,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    logWarn(
      logger,
      { error: err?.message || String(err) },
      'goal_cleanup_sweep_failed',
    );
    return {
      deleted: 0,
      scanned: 0,
      durationMs: Date.now() - startedAt,
      error: err?.message || String(err),
    };
  }
}

// Interval handle (module-singleton). Exposed via `stopGoalCleanup`
// for tests + the shutdown registry.
let cleanupInterval = null;

/**
 * Run the boot sweep + (optionally) install the periodic sweeper.
 *
 * MUST NEVER throw out of this function — a transient DB blip during
 * boot can't be allowed to take the whole server down. All errors are
 * logged and surfaced via the returned summary.
 *
 * Honours `GOAL_CLEANUP_ENABLED=0` (or `false`/`off`/`no`): returns
 * immediately with a `{ skipped: true, reason: 'disabled' }` summary
 * and does NOT schedule the interval.
 */
async function startGoalCleanup({
  logger,
  env = process.env,
  runInterval = true,
} = {}) {
  const config = readConfig(env);
  if (!config.enabled) {
    logInfo(
      logger,
      {
        retentionMs: config.retentionMs,
        intervalMs: config.intervalMs,
      },
      'goal_cleanup_disabled',
    );
    return {
      deleted: 0,
      scanned: 0,
      durationMs: 0,
      skipped: true,
      reason: 'disabled',
    };
  }

  let summary;
  try {
    summary = await runGoalCleanupSweep({ logger, env });
  } catch (err) {
    logWarn(
      logger,
      { error: err?.message || String(err) },
      'goal_cleanup_boot_pass_failed',
    );
    summary = {
      deleted: 0,
      scanned: 0,
      durationMs: 0,
      error: err?.message || String(err),
    };
  }

  const fields = {
    deleted: summary.deleted || 0,
    scanned: summary.scanned || 0,
    durationMs: summary.durationMs || 0,
    retentionMs: config.retentionMs,
  };
  if (fields.deleted > 0) {
    logWarn(logger, fields, 'goal_cleanup_boot_completed');
  } else {
    logInfo(logger, fields, 'goal_cleanup_boot_noop');
  }

  if (runInterval && !cleanupInterval && config.intervalMs > 0) {
    cleanupInterval = setInterval(() => {
      runGoalCleanupSweep({ logger, env })
        .then((result) => {
          if ((result.deleted || 0) > 0) {
            logWarn(
              logger,
              {
                deleted: result.deleted || 0,
                scanned: result.scanned || 0,
                durationMs: result.durationMs || 0,
                scope: 'interval',
              },
              'goal_cleanup_interval_completed',
            );
          }
        })
        .catch((err) => {
          logWarn(
            logger,
            { error: err?.message || String(err) },
            'goal_cleanup_interval_failed',
          );
        });
    }, config.intervalMs);
    if (typeof cleanupInterval.unref === 'function') cleanupInterval.unref();
  }

  return summary;
}

/**
 * Stop the interval sweeper (no-op if it isn't running). Exposed for
 * tests + the graceful shutdown path.
 */
function stopGoalCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

module.exports = {
  DEFAULT_RETENTION_MS,
  DEFAULT_INTERVAL_MS,
  readConfig,
  runGoalCleanupSweep,
  startGoalCleanup,
  stopGoalCleanup,
};
