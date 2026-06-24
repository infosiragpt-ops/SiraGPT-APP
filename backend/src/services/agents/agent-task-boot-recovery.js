'use strict';

const defaultTaskStore = require('./task-store');

const DEFAULT_BOOT_RECOVERY_STALE_MS = 60 * 1000;
const DEFAULT_JOB_BACKED_STALE_MS = 24 * 60 * 60 * 1000;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function envFlag(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
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

function recoverAgentTasksAfterBoot({
  env = process.env,
  logger,
  taskStore = defaultTaskStore,
} = {}) {
  if (envFlag(env.AGENT_TASK_BOOT_RECOVERY_DISABLED)) {
    logInfo(logger, { reason: 'disabled' }, 'agent_task_boot_recovery_skipped');
    return { count: 0, skipped: true, reason: 'disabled' };
  }

  const staleAfterMs = parseNonNegativeInt(
    env.AGENT_TASK_BOOT_RECOVERY_STALE_MS,
    DEFAULT_BOOT_RECOVERY_STALE_MS,
  );
  const skipJobBacked = Boolean(env.REDIS_URL);
  // Job-backed rows get a longer grace (the worker may still own them),
  // but beyond this ceiling they are zombies and must be failed honestly
  // instead of being rescanned and skipped on every boot forever.
  const jobBackedStaleAfterMs = parseNonNegativeInt(
    env.AGENT_TASK_BOOT_RECOVERY_JOB_STALE_MS,
    DEFAULT_JOB_BACKED_STALE_MS,
  );

  try {
    const result = taskStore.recoverStaleRunningTasks({
      staleAfterMs,
      reason: 'recovered_after_boot',
      skipJobBacked,
      jobBackedStaleAfterMs,
    });
    const recovered = Array.isArray(result.recovered) ? result.recovered : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const fields = {
      count: result.count || recovered.length,
      skippedCount: result.skippedCount || skipped.length,
      staleAfterMs,
      skipJobBacked,
      taskIds: recovered.map((row) => row.taskId).filter(Boolean).slice(0, 20),
      skippedTaskIds: skipped.map((row) => row.taskId).filter(Boolean).slice(0, 20),
    };

    if (fields.count > 0 || fields.skippedCount > 0) {
      logWarn(logger, fields, 'agent_task_boot_recovery_completed');
    } else {
      logInfo(logger, fields, 'agent_task_boot_recovery_noop');
    }

    return {
      ...result,
      count: fields.count,
      skippedCount: fields.skippedCount,
      staleAfterMs,
      skipJobBacked,
    };
  } catch (err) {
    logWarn(
      logger,
      {
        staleAfterMs,
        skipJobBacked,
        error: err && err.message ? err.message : String(err),
      },
      'agent_task_boot_recovery_failed',
    );
    return {
      count: 0,
      skippedCount: 0,
      staleAfterMs,
      skipJobBacked,
      error: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = {
  DEFAULT_BOOT_RECOVERY_STALE_MS,
  DEFAULT_JOB_BACKED_STALE_MS,
  recoverAgentTasksAfterBoot,
};
