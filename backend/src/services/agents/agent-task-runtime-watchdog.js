'use strict';

/**
 * Runtime stale-task watchdog for /agentes agent jobs.
 *
 * Pattern port of OpenClaw's reliability "no-output" watchdog (MIT,
 * github.com/openclaw/openclaw — agents/cli-runner reliability watchdog).
 * Ideas only; this is not a dump of the OpenClaw monorepo.
 *
 * Boot recovery already fails snapshots that were in-flight when *this*
 * process restarted. That does not cover the live hang: a BullMQ worker
 * (or the in-process runner) dies, the API stays up, and the snapshot
 * remains `running`/`queued`. The chat client then keeps "Pensando…"
 * until a reload, and even after reload the status is still in-flight.
 *
 * Live runners pulse `touchTaskHeartbeat` every ~30s. This watchdog
 * periodically reaps in-flight snapshots whose `updatedAt` is older than
 * the stale window (default 120s ≈ four missed pulses) and writes a
 * terminal `error` so SSE/pollers stop hanging. Fresh heartbeats are
 * left alone. Job-backed rows are *not* skipped — freshness is the
 * liveness signal, not the presence of a jobId.
 *
 * Disable with AGENT_TASK_RUNTIME_WATCHDOG_DISABLED=1.
 */

const defaultTaskStore = require('./task-store');

const DEFAULT_WATCHDOG_INTERVAL_MS = 30 * 1000;
const DEFAULT_WATCHDOG_STALE_MS = 120 * 1000;
const MIN_WATCHDOG_INTERVAL_MS = 5 * 1000;
const MIN_WATCHDOG_STALE_MS = 30 * 1000;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const WORKER_STALLED_REASON = 'worker_stalled';
const WORKER_STALLED_MESSAGE =
  'El worker dejó de responder. La tarea se cerró para que no quede en progreso infinito. Puedes reintentar.';

let watchdogTimer = null;

function envFlag(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function parsePositiveInt(value, fallback, min) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function logInfo(logger, fields, message) {
  if (logger && typeof logger.info === 'function') {
    logger.info(fields, message);
  }
}

function logWarn(logger, fields, message) {
  if (logger && typeof logger.warn === 'function') {
    logger.warn(fields, message);
  }
}

/**
 * One sweep: mark in-flight snapshots with a stale `updatedAt` as terminal.
 * Pure aside from the store writes; injectable for tests.
 */
function sweepStaleAgentTasks({
  env = process.env,
  logger,
  taskStore = defaultTaskStore,
} = {}) {
  if (envFlag(env.AGENT_TASK_RUNTIME_WATCHDOG_DISABLED)) {
    return { count: 0, skipped: true, reason: 'disabled' };
  }

  const staleAfterMs = parsePositiveInt(
    env.AGENT_TASK_RUNTIME_WATCHDOG_STALE_MS,
    DEFAULT_WATCHDOG_STALE_MS,
    MIN_WATCHDOG_STALE_MS,
  );

  try {
    const result = taskStore.recoverStaleRunningTasks({
      staleAfterMs,
      reason: WORKER_STALLED_REASON,
      skipJobBacked: false,
      errorMessage: WORKER_STALLED_MESSAGE,
    });
    const recovered = Array.isArray(result.recovered) ? result.recovered : [];
    const fields = {
      count: result.count || recovered.length,
      staleAfterMs,
      taskIds: recovered.map((row) => row.taskId).filter(Boolean).slice(0, 20),
    };
    if (fields.count > 0) {
      logWarn(logger, fields, 'agent_task_runtime_watchdog_reaped');
    }
    return {
      ...result,
      count: fields.count,
      staleAfterMs,
      reason: WORKER_STALLED_REASON,
    };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    logWarn(logger, { staleAfterMs, error }, 'agent_task_runtime_watchdog_failed');
    return { count: 0, staleAfterMs, error };
  }
}

function startAgentTaskRuntimeWatchdog({
  env = process.env,
  logger,
  taskStore = defaultTaskStore,
  setIntervalFn = setInterval,
} = {}) {
  if (watchdogTimer) return watchdogTimer;
  if (envFlag(env.AGENT_TASK_RUNTIME_WATCHDOG_DISABLED)) {
    logInfo(logger, { reason: 'disabled' }, 'agent_task_runtime_watchdog_skipped');
    return null;
  }

  const intervalMs = parsePositiveInt(
    env.AGENT_TASK_RUNTIME_WATCHDOG_INTERVAL_MS,
    DEFAULT_WATCHDOG_INTERVAL_MS,
    MIN_WATCHDOG_INTERVAL_MS,
  );

  const tick = () => {
    try {
      sweepStaleAgentTasks({ env, logger, taskStore });
    } catch (err) {
      logWarn(
        logger,
        { error: err && err.message ? err.message : String(err) },
        'agent_task_runtime_watchdog_tick_failed',
      );
    }
  };

  // First sweep waits one interval so a just-started runner can pulse
  // `updatedAt` before we decide it is dead.
  watchdogTimer = setIntervalFn(tick, intervalMs);
  if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
    watchdogTimer.unref();
  }
  logInfo(logger, { intervalMs }, 'agent_task_runtime_watchdog_started');
  return watchdogTimer;
}

function stopAgentTaskRuntimeWatchdog() {
  if (!watchdogTimer) return false;
  try { clearInterval(watchdogTimer); } catch { /* never throw from stop */ }
  watchdogTimer = null;
  return true;
}

function isAgentTaskRuntimeWatchdogRunning() {
  return watchdogTimer != null;
}

module.exports = {
  DEFAULT_WATCHDOG_INTERVAL_MS,
  DEFAULT_WATCHDOG_STALE_MS,
  WORKER_STALLED_REASON,
  WORKER_STALLED_MESSAGE,
  sweepStaleAgentTasks,
  startAgentTaskRuntimeWatchdog,
  stopAgentTaskRuntimeWatchdog,
  isAgentTaskRuntimeWatchdogRunning,
};
