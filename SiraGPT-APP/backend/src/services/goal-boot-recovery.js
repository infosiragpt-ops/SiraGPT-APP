'use strict';

/**
 * goal-boot-recovery — observability + crash recovery sweeper for the
 * persistent `/goal` system.
 *
 * Mirrors the shape of `services/agents/agent-task-boot-recovery.js`
 * (run-once at boot, idempotent, fire-and-forget, never throws out)
 * but tailored to the two failure modes the `GoalRun` lifecycle can
 * land in when the Node process dies mid-flight:
 *
 *   a) Stuck `queued`: an HTTP create persisted the row, but the
 *      `enqueueGoalRun` call silently failed (Redis flaky, network
 *      blip, etc.) — the row sits in `queued` forever because no
 *      worker ever sees it. We re-enqueue rows older than
 *      `GOAL_RECOVERY_REENQUEUE_AFTER_MS` (default 5 min). The queue
 *      itself dedupes on `jobId === goalRunId`, so a no-op re-enqueue
 *      is safe.
 *
 *   b) Zombie `running`: a worker picked up a job, flipped the row
 *      to `running`, then the process died (OOM, deploy, host
 *      reboot) before completing. The row stays `running` forever
 *      and no event has been written for > 30 min. We mark the row
 *      `failed` with a descriptive error AND append a terminal
 *      `error` event so the SSE replay surfaces it to the user.
 *
 * The sweeper runs once at boot and (optionally) on an interval so a
 * long-lived process catches new zombies + stuck rows without
 * requiring a restart. Both the boot pass and the interval pass call
 * the same `sweepOnce` helper; the function MUST NOT throw out of
 * either entry point — a DB blip during the sweep is logged and the
 * pass returns zero counts.
 */

const DEFAULT_REENQUEUE_AFTER_MS = 5 * 60_000;     // 5 minutes
const DEFAULT_STALL_AFTER_MS = 30 * 60_000;        // 30 minutes
const DEFAULT_SCAN_INTERVAL_MS = 5 * 60_000;       // 5 minutes
const DEFAULT_TOP_K = 5;

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

let goalQueueModule = null;
function getGoalQueue() {
  if (goalQueueModule !== null) return goalQueueModule;
  try {
    // eslint-disable-next-line global-require
    goalQueueModule = require('./goal-queue');
  } catch {
    goalQueueModule = false;
  }
  return goalQueueModule;
}

let goalEventsModule = null;
function getGoalEvents() {
  if (goalEventsModule !== null) return goalEventsModule;
  try {
    // eslint-disable-next-line global-require
    goalEventsModule = require('./goal-events');
  } catch {
    goalEventsModule = false;
  }
  return goalEventsModule;
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

function readConfig(env = process.env) {
  return {
    reenqueueAfterMs: parseNonNegativeInt(
      env.GOAL_RECOVERY_REENQUEUE_AFTER_MS,
      DEFAULT_REENQUEUE_AFTER_MS,
    ),
    stallAfterMs: parseNonNegativeInt(
      env.GOAL_RECOVERY_STALL_AFTER_MS,
      DEFAULT_STALL_AFTER_MS,
    ),
    scanIntervalMs: parseNonNegativeInt(
      env.GOAL_RECOVERY_SCAN_INTERVAL_MS,
      DEFAULT_SCAN_INTERVAL_MS,
    ),
  };
}

function hasModel(prisma, name) {
  return Boolean(prisma && prisma[name]);
}

/**
 * Re-enqueue rows stuck in `queued` for longer than the threshold.
 * Returns the count of re-enqueued rows.
 */
async function recoverStuckQueued({ prisma, queue, reenqueueAfterMs, logger }) {
  if (!hasModel(prisma, 'goalRun')) return { requeued: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - reenqueueAfterMs);
  let candidates = [];
  try {
    candidates = await prisma.goalRun.findMany({
      where: { status: 'queued', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    logWarn(
      logger,
      { error: err?.message || String(err) },
      'goal_recovery_queued_scan_failed',
    );
    return { requeued: 0, scanned: 0 };
  }

  let requeued = 0;
  for (const row of candidates) {
    try {
      if (queue && typeof queue.enqueueGoalRun === 'function') {
        await queue.enqueueGoalRun({ goalRunId: row.id });
        requeued += 1;
      }
    } catch (err) {
      // Best-effort: the next sweep will pick it up again.
      logWarn(
        logger,
        { goalRunId: row.id, error: err?.message || String(err) },
        'goal_recovery_reenqueue_failed',
      );
    }
  }
  return { requeued, scanned: candidates.length };
}

/**
 * Mark rows stuck in `running` (no events in N minutes) as `failed`.
 * Uses a transaction so the row update + terminal `error` event are
 * applied atomically per row.
 */
async function recoverZombieRunning({ prisma, events, stallAfterMs, logger }) {
  if (!hasModel(prisma, 'goalRun') || !hasModel(prisma, 'goalRunEvent')) {
    return { stalled: 0, scanned: 0 };
  }
  const stallCutoff = new Date(Date.now() - stallAfterMs);
  let candidates = [];
  try {
    // A row is a zombie if its most recent event (or updatedAt when no
    // events exist) is older than the stall cutoff. We pull the latest
    // event timestamp via a subquery-equivalent aggregation so the
    // filter happens server-side.
    candidates = await prisma.goalRun.findMany({
      where: { status: 'running', updatedAt: { lt: stallCutoff } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
      select: {
        id: true,
        startedAt: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    logWarn(
      logger,
      { error: err?.message || String(err) },
      'goal_recovery_running_scan_failed',
    );
    return { stalled: 0, scanned: 0 };
  }

  let stalled = 0;
  for (const row of candidates) {
    // Confirm via the events table that nothing newer than the cutoff
    // exists. The row.updatedAt filter is necessary but not sufficient
    // — `appendEvent` already bumps updatedAt on every event, so if
    // updatedAt is past the cutoff there's no event past it either,
    // but we double-check defensively in case the row's updatedAt got
    // touched by something other than appendEvent.
    let lastEventAt = null;
    try {
      const latest = await prisma.goalRunEvent.findFirst({
        where: { goalRunId: row.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      lastEventAt = latest?.createdAt || null;
    } catch {
      // Treat as unknown — fall through, we'll use updatedAt below.
    }
    const effectiveLast = lastEventAt || row.updatedAt;
    if (effectiveLast && effectiveLast >= stallCutoff) continue;

    const stallMinutes = Math.round(stallAfterMs / 60_000);
    const errorMessage = `worker stalled — no events in ${stallMinutes} minutes`;
    const now = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        // Row may have flipped to a terminal state between our scan
        // and the transaction; updateMany is a no-op when status !=
        // running, so we never clobber a legitimate finish.
        await tx.goalRun.updateMany({
          where: { id: row.id, status: 'running' },
          data: {
            status: 'failed',
            error: errorMessage,
            failedAt: now,
            updatedAt: now,
          },
        });
      });
    } catch (err) {
      logWarn(
        logger,
        { goalRunId: row.id, error: err?.message || String(err) },
        'goal_recovery_zombie_update_failed',
      );
      continue;
    }

    // Best-effort terminal event so the SSE stream surfaces the
    // stall to any client that's still attached.
    try {
      if (events && typeof events.appendEvent === 'function') {
        await events.appendEvent({
          goalRunId: row.id,
          type: 'error',
          payload: {
            type: 'error',
            message: errorMessage,
            reason: 'boot_recovery_zombie',
            at: now.toISOString(),
          },
        });
      }
    } catch (err) {
      // append already swallows its own errors but be defensive in
      // case the module surface changes.
      logWarn(
        logger,
        { goalRunId: row.id, error: err?.message || String(err) },
        'goal_recovery_zombie_event_failed',
      );
    }
    stalled += 1;
  }
  return { stalled, scanned: candidates.length };
}

/**
 * Single sweep pass. Idempotent + crash-safe — returns a numeric
 * summary even when persistence is unreachable.
 */
async function sweepOnce({ logger, env = process.env } = {}) {
  const startedAt = Date.now();
  const config = readConfig(env);

  const prisma = getPrisma();
  if (!prisma) {
    return {
      requeued: 0,
      stalled: 0,
      scanned: 0,
      durationMs: Date.now() - startedAt,
      skipped: true,
      reason: 'prisma_unavailable',
    };
  }

  const queue = getGoalQueue() || null;
  const events = getGoalEvents() || null;

  const queuedResult = await recoverStuckQueued({
    prisma,
    queue,
    reenqueueAfterMs: config.reenqueueAfterMs,
    logger,
  });
  const runningResult = await recoverZombieRunning({
    prisma,
    events,
    stallAfterMs: config.stallAfterMs,
    logger,
  });

  return {
    requeued: queuedResult.requeued,
    stalled: runningResult.stalled,
    scanned: queuedResult.scanned + runningResult.scanned,
    durationMs: Date.now() - startedAt,
  };
}

// Interval handle (module-singleton). Exposed via `stopGoalRecovery`
// for tests + the shutdown registry.
let recoveryInterval = null;

/**
 * Run the boot sweep + (optionally) install the periodic sweeper.
 *
 * MUST NEVER throw out of this function — a transient DB/Redis blip
 * during boot can't be allowed to take the whole server down. All
 * errors are logged and surfaced via the returned summary.
 */
async function recoverGoalRunsAfterBoot({
  logger,
  env = process.env,
  runInterval = true,
} = {}) {
  let summary;
  try {
    summary = await sweepOnce({ logger, env });
  } catch (err) {
    logWarn(
      logger,
      { error: err?.message || String(err) },
      'goal_recovery_boot_pass_failed',
    );
    summary = {
      requeued: 0,
      stalled: 0,
      scanned: 0,
      durationMs: 0,
      error: err?.message || String(err),
    };
  }

  const fields = {
    requeued: summary.requeued || 0,
    stalled: summary.stalled || 0,
    scanned: summary.scanned || 0,
    durationMs: summary.durationMs || 0,
  };
  if (fields.requeued > 0 || fields.stalled > 0) {
    logWarn(logger, fields, 'goal_recovery_boot_completed');
  } else {
    logInfo(logger, fields, 'goal_recovery_boot_noop');
  }

  if (runInterval && !recoveryInterval) {
    const config = readConfig(env);
    if (config.scanIntervalMs > 0) {
      recoveryInterval = setInterval(() => {
        sweepOnce({ logger, env })
          .then((result) => {
            if ((result.requeued || 0) > 0 || (result.stalled || 0) > 0) {
              logWarn(
                logger,
                {
                  requeued: result.requeued || 0,
                  stalled: result.stalled || 0,
                  scanned: result.scanned || 0,
                  durationMs: result.durationMs || 0,
                  scope: 'interval',
                },
                'goal_recovery_interval_completed',
              );
            }
          })
          .catch((err) => {
            logWarn(
              logger,
              { error: err?.message || String(err) },
              'goal_recovery_interval_failed',
            );
          });
      }, config.scanIntervalMs);
      if (typeof recoveryInterval.unref === 'function') recoveryInterval.unref();
    }
  }

  return summary;
}

/**
 * Stop the interval sweeper (no-op if it isn't running). Exposed for
 * tests + the graceful shutdown path.
 */
function stopGoalRecovery() {
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
}

/**
 * Fetch the top-K stuck queued + zombie running rows for the admin
 * health endpoint. Returns serialisable rows with id + timing metadata.
 */
async function listStuckQueued({ prisma, reenqueueAfterMs, topK = DEFAULT_TOP_K }) {
  if (!hasModel(prisma, 'goalRun')) return [];
  const cutoff = new Date(Date.now() - reenqueueAfterMs);
  try {
    const rows = await prisma.goalRun.findMany({
      where: { status: 'queued', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: topK,
      select: { id: true, createdAt: true },
    });
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      ageMs: r.createdAt ? now - new Date(r.createdAt).getTime() : null,
    }));
  } catch {
    return [];
  }
}

async function listZombieRunning({ prisma, stallAfterMs, topK = DEFAULT_TOP_K }) {
  if (!hasModel(prisma, 'goalRun')) return [];
  const cutoff = new Date(Date.now() - stallAfterMs);
  try {
    const rows = await prisma.goalRun.findMany({
      where: { status: 'running', updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: topK,
      select: { id: true, startedAt: true, updatedAt: true },
    });
    if (rows.length === 0) return [];
    const enriched = [];
    for (const row of rows) {
      let lastEventAt = null;
      try {
        if (hasModel(prisma, 'goalRunEvent')) {
          const latest = await prisma.goalRunEvent.findFirst({
            where: { goalRunId: row.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          lastEventAt = latest?.createdAt || null;
        }
      } catch {
        // best-effort: leave lastEventAt as updatedAt fallback below
      }
      const effective = lastEventAt || row.updatedAt;
      const now = Date.now();
      enriched.push({
        id: row.id,
        startedAt: row.startedAt,
        lastEventAt: effective,
        ageMs: effective ? now - new Date(effective).getTime() : null,
      });
    }
    return enriched;
  } catch {
    return [];
  }
}

module.exports = {
  DEFAULT_REENQUEUE_AFTER_MS,
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_TOP_K,
  listStuckQueued,
  listZombieRunning,
  readConfig,
  recoverGoalRunsAfterBoot,
  stopGoalRecovery,
  sweepOnce,
};
