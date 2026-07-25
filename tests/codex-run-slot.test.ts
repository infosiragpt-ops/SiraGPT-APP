import assert from "node:assert/strict"
import test from "node:test"

import type { CodexRun } from "../lib/codex/codex-api"
import {
  activeCodexRun,
  isCodexRunInProgressError,
  runWhenCodexProjectIdle,
} from "../lib/codex/run-slot"

function run(status: string, createdAt: string): CodexRun {
  return {
    id: `${status}-${createdAt}`,
    projectId: "project-1",
    mode: "plan",
    status,
    tier: null,
    model: null,
    planRunId: null,
    prompt: null,
    error: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  }
}

test("activeCodexRun returns the newest active project run", () => {
  const active = activeCodexRun([
    run("done", "2026-07-25T10:00:00.000Z"),
    run("queued", "2026-07-25T10:02:00.000Z"),
    run("running", "2026-07-25T10:03:00.000Z"),
  ])
  assert.equal(active?.status, "running")
})

test("run-in-progress detection is restricted to the backend conflict contract", () => {
  assert.equal(
    isCodexRunInProgressError({
      status: 409,
      body: { error: "run_in_progress" },
    }),
    true,
  )
  assert.equal(isCodexRunInProgressError({ status: 409, body: { error: "other" } }), false)
  assert.equal(isCodexRunInProgressError(new Error("run_in_progress")), false)
})

test("a conflicting department run is queued and retried without cancellation", async () => {
  let operationCalls = 0
  let listCalls = 0
  const waited: Array<string | null> = []
  const result = await runWhenCodexProjectIdle({
    projectId: "project-1",
    pollMs: 1,
    timeoutMs: 500,
    operation: async () => {
      operationCalls += 1
      if (operationCalls === 1) {
        throw Object.assign(new Error("run_in_progress"), {
          status: 409,
          body: { error: "run_in_progress" },
        })
      }
      return "created"
    },
    listRuns: async () => {
      listCalls += 1
      return listCalls === 1 ? [run("running", "2026-07-25T10:03:00.000Z")] : []
    },
    onWait: (active) => waited.push(active?.status || null),
  })

  assert.equal(result, "created")
  assert.equal(operationCalls, 2)
  assert.deepEqual(waited, ["running", null])
})

test("the queued operation remains cancellable", async () => {
  const controller = new AbortController()
  await assert.rejects(
    runWhenCodexProjectIdle({
      projectId: "project-1",
      pollMs: 20,
      timeoutMs: 500,
      signal: controller.signal,
      operation: async () => {
        throw Object.assign(new Error("run_in_progress"), {
          status: 409,
          body: { error: "run_in_progress" },
        })
      },
      listRuns: async () => {
        controller.abort()
        return [run("running", "2026-07-25T10:03:00.000Z")]
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  )
})
