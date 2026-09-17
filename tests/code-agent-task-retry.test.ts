/**
 * Tests for structured per-task retries (Frente 1): transient step failures
 * requeue with backoff instead of abandoning the plan as blocked.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { AgentTask } from "../lib/code-agent/types"
import {
  MAX_TASK_RETRIES,
  BASE_TASK_RETRY_DELAY_MS,
  MAX_TASK_RETRY_DELAY_MS,
  computeTaskRetryDelayMs,
  markTaskFailure,
  pickResumableTask,
} from "../lib/code-agent/task-retry"
import { nextWorkTaskAction } from "../lib/code-agent/autonomy"

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "Crear pantalla de login",
    status: "in_progress",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("computeTaskRetryDelayMs", () => {
  test("grows exponentially and is capped", () => {
    assert.equal(computeTaskRetryDelayMs(1), BASE_TASK_RETRY_DELAY_MS)
    assert.equal(computeTaskRetryDelayMs(2), BASE_TASK_RETRY_DELAY_MS * 2)
    const capped = computeTaskRetryDelayMs(10)
    assert.equal(capped, MAX_TASK_RETRY_DELAY_MS)
  })
})

describe("markTaskFailure", () => {
  const NOW = 10_000

  test("transient failure requeues the same task with backoff", () => {
    const t = markTaskFailure(task(), { transient: true, reason: "validación falló" }, NOW)
    assert.equal(t.status, "pending")
    assert.equal(t.attempts, 1)
    assert.equal(t.notBefore, NOW + BASE_TASK_RETRY_DELAY_MS)
    assert.equal(t.lastError, "validación falló")
  })

  test("second transient failure doubles the delay", () => {
    const once = markTaskFailure(task(), { transient: true }, NOW)
    const twice = markTaskFailure(once, { transient: true }, NOW)
    assert.equal(twice.status, "pending")
    assert.equal(twice.attempts, 2)
    assert.equal(twice.notBefore, NOW + BASE_TASK_RETRY_DELAY_MS * 2)
  })

  test("blocks once MAX_TASK_RETRIES transient attempts are spent", () => {
    let t = task()
    for (let i = 0; i < MAX_TASK_RETRIES; i++) t = markTaskFailure(t, { transient: true }, NOW)
    assert.equal(t.status, "pending")
    const spent = markTaskFailure(t, { transient: true }, NOW)
    assert.equal(spent.status, "blocked")
    assert.equal(spent.attempts, MAX_TASK_RETRIES + 1)
  })

  test("non-transient failure blocks immediately (cancellation)", () => {
    const t = markTaskFailure(task(), { transient: false, reason: "Cancelado por el usuario" }, NOW)
    assert.equal(t.status, "blocked")
    assert.equal(t.attempts, 1)
  })
})

describe("pickResumableTask", () => {
  test("prefers in_progress, then pending", () => {
    const a = task({ id: "a", status: "pending" })
    const b = task({ id: "b", status: "in_progress" })
    assert.equal(pickResumableTask([a, b])?.id, "b")
  })

  test("skips tasks still inside their notBefore cooldown", () => {
    const cooling = task({ status: "pending", notBefore: 20_000 })
    assert.equal(pickResumableTask([cooling], 10_000), null)
    const later = pickResumableTask([cooling], 20_000)
    assert.equal(later?.id, "t1")
  })

  test("a cooled-down retried task becomes eligible without blocking the plan order", () => {
    const done = task({ id: "done", status: "completed" })
    const retrying = markTaskFailure(task({ id: "r" }), { transient: true }, 1_000)
    const fresh = task({ id: "fresh", status: "pending" })
    // While r is cooling, fresh goes first.
    assert.equal(pickResumableTask([done, retrying, fresh], 2_000)?.id, "fresh")
    // Once cooled, r resumes before fresh (original order preserved).
    assert.equal(pickResumableTask([done, retrying, fresh], 6_000 + 1)?.id, "r")
  })

  test("empty/undefined lists yield null", () => {
    assert.equal(pickResumableTask(undefined), null)
    assert.equal(pickResumableTask([]), null)
    assert.equal(pickResumableTask([task({ status: "blocked" })]), null)
  })
})

describe("nextWorkTaskAction integration", () => {
  test("requeued-but-cooling task does NOT dispatch; cooled one does", () => {
    const cooling = markTaskFailure(task({ id: "r" }), { transient: true }, 1_000)
    const passthrough = nextWorkTaskAction({ phase: "preview", intakeStep: 0, context: { goal: "app" }, tasks: [cooling] }, 2_000)
    assert.equal(passthrough.type, "passthrough")
    const go = nextWorkTaskAction({ phase: "preview", intakeStep: 0, context: { goal: "app" }, tasks: [cooling] }, 7_000)
    assert.equal(go.type, "work_task")
    if (go.type === "work_task") assert.equal(go.taskId, "r")
  })
})
