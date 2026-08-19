'use strict';

/**
 * agent-task.activity — Activity implementation that runs an
 * `agent-task` payload inside a Temporal worker.
 *
 * The activity delegates to the *same* `runAgentTaskJob` function the
 * BullMQ worker uses today, so we don't fork the runtime path: both
 * workers exercise identical agent code, just with different
 * scheduling/retry plumbing. That's the only way an A/B comparison
 * between BullMQ and Temporal is meaningful.
 *
 * Heartbeats are emitted every 30 s so Temporal can detect a stuck
 * worker (lock equivalent to BullMQ's `lockDuration`/`stalledInterval`).
 */

const { Context, ApplicationFailure } = require('@temporalio/activity');
const { runAgentTaskJob } = require('../../agent-task-runner');
const { classifyTaskError } = require('../../../../utils/task-error-classifier');

async function runAgentTaskActivity(jobData /* , meta */) {
  const ctx = Context.current();
  const heartbeat = setInterval(() => {
    try { ctx.heartbeat({ ts: Date.now() }); } catch (_err) { /* noop */ }
  }, 30_000);

  try {
    // Pass a synthetic `job` object so `runAgentTaskJob` can read
    // `job.id` / `job.attemptsMade` like it does for BullMQ jobs.
    const syntheticJob = {
      id: jobData && (jobData.taskId || jobData.id) || ctx.info.workflowExecution.workflowId,
      attemptsMade: Math.max(0, (ctx.info.attempt || 1) - 1),
      data: jobData,
    };
    const result = await runAgentTaskJob(jobData, syntheticJob);
    return result;
  } catch (err) {
    // Convert non-retryable classifications into ApplicationFailure with
    // `nonRetryable: true` so Temporal stops attempting immediately.
    const classification = classifyTaskError(err);
    if (classification && classification.retryable === false) {
      throw ApplicationFailure.create({
        message: err && err.message ? err.message : 'agent task failed',
        type: 'NonRetryableTaskError',
        nonRetryable: true,
        details: [{ reason: classification.reason }],
      });
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = { runAgentTaskActivity };
