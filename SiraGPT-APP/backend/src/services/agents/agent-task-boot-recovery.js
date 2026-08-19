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

// Cap on how many interrupted tasks a single boot will re-enqueue —
// a crash-loop must not turn old checkpoints into an enqueue stampede.
const DEFAULT_BOOT_RESUME_LIMIT = 10;

/**
 * Re-enqueue tasks that the fail-pass just marked 'error' but that carry a
 * react-agent runnerCheckpoint (real mid-run progress). The re-enqueued job
 * resumes the loop from the last completed step. Best-effort per task: a
 * failed enqueue leaves the honest 'error' status untouched.
 */
async function resumeCheckpointedTasks({
  env = process.env,
  logger,
  taskStore = defaultTaskStore,
  recoveredRows = [],
  enqueue = null,
} = {}) {
  const limit = parseNonNegativeInt(env.AGENT_TASK_BOOT_RESUME_LIMIT, DEFAULT_BOOT_RESUME_LIMIT);
  if (limit === 0) return { resumed: 0, reason: 'limit_zero' };
  // Lazy require: agent-task-queue pulls in BullMQ/Redis; boot recovery must
  // stay importable in environments without them (tests inject `enqueue`).
  // eslint-disable-next-line global-require
  const enqueueAgentTask = enqueue || require('./agent-task-queue').enqueueAgentTask;
  let resumed = 0;
  for (const row of recoveredRows) {
    if (resumed >= limit) break;
    if (!row?.taskId || !row?.userId) continue;
    let snapshot;
    try {
      snapshot = taskStore.readTaskSnapshot(row.taskId);
    } catch { continue; }
    const checkpoint = snapshot?.runnerCheckpoint;
    if (!checkpoint || !(Number(checkpoint.stepsCompleted) > 0)) continue;
    try {
      const job = await enqueueAgentTask({
        taskId: snapshot.taskId,
        traceId: snapshot.traceId || null,
        user: { id: snapshot.userId, clearance: snapshot.userClearance || 'authenticated' },
        goal: snapshot.agentGoal || snapshot.displayGoal,
        displayGoal: snapshot.displayGoal,
        systemContract: snapshot.systemContract || '',
        files: snapshot.fileIds || [],
        chatId: snapshot.chatId || null,
        model: snapshot.model || 'gpt-4o',
        maxSteps: snapshot.maxSteps || 60,
        maxRuntimeMs: snapshot.maxRuntimeMs || 2 * 60 * 60 * 1000,
        documentPolicy: snapshot.documentPolicy || null,
        openclawRuntimeProfile: snapshot.openclawRuntimeProfile || null,
        retryOf: snapshot.taskId,
        resumeCheckpoint: checkpoint,
      }, { priority: 1, jobId: `${snapshot.taskId}-boot-resume-${Date.now()}` });
      taskStore.appendTaskEvent(
        { ...snapshot, status: 'queued', jobId: String(job.id) },
        {
          type: 'repair_attempt',
          status: 'queued',
          message: `Reanudando automáticamente desde el paso ${checkpoint.stepsCompleted} tras un reinicio del servidor.`,
        },
        { ...(snapshot.streamState || {}), done: false, error: null },
      );
      resumed += 1;
      logWarn(logger, { taskId: snapshot.taskId, step: checkpoint.stepsCompleted, jobId: String(job.id) }, 'agent_task_boot_resume_enqueued');
    } catch (err) {
      logWarn(logger, { taskId: row.taskId, error: err?.message || String(err) }, 'agent_task_boot_resume_enqueue_failed');
    }
  }
  return { resumed };
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

    // Checkpointed tasks the fail-pass just killed get a second life: re-
    // enqueue them so the loop resumes mid-run. Fire-and-forget — boot must
    // not block on Redis; a failed resume leaves the honest 'error' status.
    let resumePromise = Promise.resolve({ resumed: 0 });
    if (!envFlag(env.AGENT_TASK_RESUME_ON_BOOT_DISABLED) && env.REDIS_URL && recovered.length > 0) {
      resumePromise = resumeCheckpointedTasks({ env, logger, taskStore, recoveredRows: recovered })
        .catch((err) => {
          logWarn(logger, { error: err?.message || String(err) }, 'agent_task_boot_resume_failed');
          return { resumed: 0, error: err?.message || String(err) };
        });
    }

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
      // Exposed for tests/telemetry; boot callers ignore it (fire-and-forget).
      resumePromise,
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
  DEFAULT_BOOT_RESUME_LIMIT,
  recoverAgentTasksAfterBoot,
  resumeCheckpointedTasks,
};
