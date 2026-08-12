'use strict';

const CANCELLED_SWARM_STATUSES = new Set(['cancelling', 'cancelled']);
const RECOVERABLE_SWARM_STATUSES = new Set(['queued', 'running']);
const EXECUTABLE_SWARM_STATUSES = new Set(['queued', 'running', 'paused']);
const DEFERRED_SWARM_STATUSES = new Set(['paused']);
const TERMINAL_SWARM_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
]);

/**
 * Resolve the durable swarm state behind a Codex run. A linked run may only be
 * recovered or executed when its parent swarm is still active. State lookup is
 * fail-closed: a restart must never revive work whose cancellation authority
 * cannot be checked.
 */
async function inspectSwarmRunState({ prisma, run }) {
  const swarmTaskId = String(run?.swarmTaskId || '').trim();
  if (!swarmTaskId) {
    return {
      linked: false,
      recoverable: true,
      executable: true,
      deferred: false,
      resumable: true,
      cancelled: false,
      reason: 'not_swarm_linked',
    };
  }
  if (!prisma?.codexSwarmTask?.findUnique) {
    return {
      linked: true,
      recoverable: false,
      executable: false,
      deferred: false,
      resumable: false,
      cancelled: false,
      reason: 'swarm_state_store_unavailable',
    };
  }
  let task;
  try {
    task = await prisma.codexSwarmTask.findUnique({
      where: { id: swarmTaskId },
      select: {
        id: true,
        swarm: {
          select: {
            id: true,
            status: true,
            cancelRequestedAt: true,
          },
        },
      },
    });
  } catch (error) {
    return {
      linked: true,
      recoverable: false,
      executable: false,
      deferred: false,
      resumable: false,
      cancelled: false,
      reason: 'swarm_state_query_failed',
      error: String(error?.message || error).slice(0, 300),
    };
  }
  if (!task?.swarm) {
    return {
      linked: true,
      recoverable: false,
      executable: false,
      deferred: false,
      resumable: false,
      cancelled: false,
      reason: 'swarm_state_missing',
    };
  }
  const status = String(task.swarm.status || '').trim().toLowerCase();
  const cancelled = Boolean(task.swarm.cancelRequestedAt)
    || CANCELLED_SWARM_STATUSES.has(status);
  // `paused` deliberately means two different things depending on ownership:
  // a worker that was already claimed may finish its bounded operation, while
  // a worker lost during restart must stay queued until the explicit resume.
  // `deferred` lets recovery express that durable state without inventing a
  // CodexRun status that the rest of the lifecycle does not understand.
  const deferred = !cancelled && DEFERRED_SWARM_STATUSES.has(status);
  const recoverable = !cancelled && RECOVERABLE_SWARM_STATUSES.has(status);
  const executable = !cancelled && EXECUTABLE_SWARM_STATUSES.has(status);
  const resumable = recoverable || deferred;
  let reason = 'swarm_status_invalid';
  if (cancelled) reason = 'swarm_cancelled';
  else if (status === 'paused') reason = 'swarm_paused';
  else if (TERMINAL_SWARM_STATUSES.has(status)) reason = 'swarm_terminal';
  else if (recoverable) reason = 'swarm_active';
  return {
    linked: true,
    recoverable,
    executable,
    deferred,
    resumable,
    cancelled,
    reason,
    swarmId: task.swarm.id,
    status,
  };
}

module.exports = {
  CANCELLED_SWARM_STATUSES,
  DEFERRED_SWARM_STATUSES,
  EXECUTABLE_SWARM_STATUSES,
  RECOVERABLE_SWARM_STATUSES,
  TERMINAL_SWARM_STATUSES,
  inspectSwarmRunState,
};
