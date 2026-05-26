'use strict';

/**
 * agent-task.workflow — Temporal workflow that wraps the existing
 * `runAgentTaskJob` flow as an activity.
 *
 * This file runs ONLY inside the Temporal worker process
 * (`infra/temporal/worker.js`), never inside the main backend. Workflows
 * execute in a deterministic sandbox where `require()` of arbitrary
 * Node modules is disallowed — only `@temporalio/workflow` and the
 * activity proxy may be imported here.
 *
 * Behavior:
 *   - Proxies to the `runAgentTaskActivity` activity with the same
 *     payload BullMQ would have passed to the legacy worker.
 *   - Declarative retry policy mirrors the hand-rolled
 *     `classifyTaskError` behavior in `agent-task-runner.js`: up to
 *     `AGENT_TASK_MAX_RETRIES` attempts with exponential backoff,
 *     capped at 60 s, jittered by Temporal itself.
 *   - `startToCloseTimeout` is intentionally generous (15 min) because
 *     long-running LLM chains routinely sit on a single tool call for
 *     several minutes.
 */

const { proxyActivities, defineSignal, setHandler } = require('@temporalio/workflow');

const { runAgentTaskActivity } = proxyActivities({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '90 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 3,
    // Non-retryable errors are surfaced verbatim. The activity throws
    // `ApplicationFailure` with a `nonRetryable: true` flag for
    // permanent failures (validation, auth, content policy), so this
    // list is a defensive net and not the primary mechanism.
    nonRetryableErrorTypes: ['NonRetryableTaskError'],
  },
});

const cancelTaskSignal = defineSignal('cancel');

async function runAgentTaskWorkflow(jobData) {
  // Future signal handler: when the user clicks "cancelar" in the UI,
  // the backend sends this signal and the activity sees it via the
  // Context.cancellationSignal. Wired in a follow-up alongside the
  // signal-sender on the route handler.
  let cancelled = false;
  setHandler(cancelTaskSignal, () => { cancelled = true; });

  return runAgentTaskActivity(jobData, { cancelled });
}

module.exports = {
  runAgentTaskWorkflow,
  cancelTaskSignal,
};
