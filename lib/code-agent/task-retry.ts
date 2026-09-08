/**
 * code-agent · task-retry (pure).
 *
 * Structured per-task retries for autonomous plans: a transient step failure
 * (bad generation, validation miss) requeues the SAME task with backoff
 * instead of abandoning it as blocked. Permanent/user-driven failures
 * (cancellations, retries exhausted) stay blocked. Bounded by
 * MAX_TASK_RETRIES so a broken task can never loop forever.
 */

import type { AgentTask } from "./types"

/** Max requeues of the same task after a transient failure. */
export const MAX_TASK_RETRIES = 2
/** Base backoff before a failed task becomes eligible again. */
export const BASE_TASK_RETRY_DELAY_MS = 5000
/** Upper bound for the per-task retry backoff. */
export const MAX_TASK_RETRY_DELAY_MS = 60_000

/** Exponential backoff for a task's Nth retry (attempt is 1-based). */
export function computeTaskRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(BASE_TASK_RETRY_DELAY_MS * Math.pow(2, n - 1), MAX_TASK_RETRY_DELAY_MS)
}

export interface TaskFailureInput {
  /** True when the failure is worth another attempt (validation miss, model hiccup). False for cancellations/exhausted retries. */
  transient: boolean
  /** Human-readable cause kept on the task for actionable reporting. */
  reason?: string
}

/**
 * Stamp a task after a failed execution attempt. Transient failures go back
 * to "pending" with an escalating notBefore gate until MAX_TASK_RETRIES is
 * spent; anything else lands (or stays) "blocked".
 */
export function markTaskFailure(task: AgentTask, input: TaskFailureInput, now = Date.now()): AgentTask {
  const attempts = (task.attempts ?? 0) + 1
  if (input.transient && attempts <= MAX_TASK_RETRIES) {
    return {
      ...task,
      status: "pending",
      attempts,
      notBefore: now + computeTaskRetryDelayMs(attempts),
      lastError: input.reason,
      updatedAt: now,
    }
  }
  return { ...task, status: "blocked", attempts, lastError: input.reason, updatedAt: now }
}

/**
 * Next executable task, honouring per-task retry backoff. Same preference as
 * nextPendingTask (an in_progress task wins) but skips tasks whose notBefore
 * is still in the future — they were requeued too recently to hammer again.
 */
export function pickResumableTask(tasks: AgentTask[] | undefined, now = Date.now()): AgentTask | null {
  const list = tasks || []
  const eligible = (t: AgentTask) => t.notBefore == null || t.notBefore <= now
  const inProgress = list.find((t) => t.status === "in_progress" && eligible(t))
  if (inProgress) return inProgress
  return list.find((t) => t.status === "pending" && eligible(t)) ?? null
}
