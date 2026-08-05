import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  cancelCodexRunFamily,
  createCodexRunWithCancellationFence,
} from "../lib/codex/cancel-run-family"

describe("cancelCodexRunFamily", () => {
  it("uses the atomic server family endpoint when available", async () => {
    let listCalls = 0
    let singleCalls = 0
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-1", runId: "plan-atomic" },
      {
        cancelRun: async () => { singleCalls += 1 },
        cancelFamily: async (runId) => {
          assert.equal(runId, "plan-atomic")
          return { cancelledRunIds: ["plan-atomic", "build-atomic"] }
        },
        listRuns: async () => { listCalls += 1; return [] },
      },
    )
    assert.deepEqual(cancelled, ["plan-atomic", "build-atomic"])
    assert.equal(singleCalls, 0)
    assert.equal(listCalls, 0)
  })

  it("falls back to legacy cancellation when a rolling-deploy backend lacks the family endpoint", async () => {
    const singleCalls: string[] = []
    let familyCalls = 0
    let listCalls = 0
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-rolling", runId: "plan-rolling" },
      {
        cancelFamily: async () => {
          familyCalls += 1
          throw Object.assign(new Error("Route not found"), {
            status: 404,
            body: { error: "Route not found" },
          })
        },
        cancelRun: async (runId) => { singleCalls.push(runId) },
        listRuns: async () => {
          listCalls += 1
          return [
            { id: "plan-rolling", status: "running" },
            { id: "build-rolling", status: "queued", planRunId: "plan-rolling" },
          ]
        },
      },
    )

    assert.equal(familyCalls, 1)
    assert.equal(listCalls, 2)
    assert.deepEqual(singleCalls, ["plan-rolling", "build-rolling"])
    assert.deepEqual(cancelled, ["plan-rolling", "build-rolling"])
  })

  it("recognizes an empty-body route 404 from an older backend and verifies via legacy endpoints", async () => {
    const singleCalls: string[] = []
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-rolling", runId: "plan-empty-404" },
      {
        cancelFamily: async () => {
          throw Object.assign(new Error("codex http 404"), { status: 404, body: {} })
        },
        cancelRun: async (runId) => { singleCalls.push(runId) },
        listRuns: async () => [],
      },
    )

    assert.deepEqual(singleCalls, ["plan-empty-404"])
    assert.deepEqual(cancelled, ["plan-empty-404"])
  })

  it("keeps a semantic run_not_found response idempotent without probing legacy endpoints", async () => {
    let singleCalls = 0
    let listCalls = 0
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-1", runId: "run-gone" },
      {
        cancelFamily: async () => {
          throw Object.assign(new Error("run not found"), {
            status: 404,
            body: { error: "run_not_found" },
          })
        },
        cancelRun: async () => { singleCalls += 1 },
        listRuns: async () => { listCalls += 1; return [] },
      },
    )

    assert.deepEqual(cancelled, [])
    assert.equal(singleCalls, 0)
    assert.equal(listCalls, 0)
  })

  it("does not treat an unrelated family 404 as successful cancellation", async () => {
    let singleCalls = 0
    let listCalls = 0
    const upstreamError = Object.assign(new Error("project not found"), {
      status: 404,
      body: { error: "project_not_found" },
    })

    await assert.rejects(
      cancelCodexRunFamily(
        { projectId: "project-gone", runId: "run-unknown" },
        {
          cancelFamily: async () => { throw upstreamError },
          cancelRun: async () => { singleCalls += 1 },
          listRuns: async () => { listCalls += 1; return [] },
        },
      ),
      (error) => error === upstreamError,
    )
    assert.equal(singleCalls, 0)
    assert.equal(listCalls, 0)
  })

  it("cancels the visible plan and its auto-continued build exactly once", async () => {
    const calls: string[] = []
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-1", runId: "plan-1" },
      {
        cancelRun: async (runId) => { calls.push(runId) },
        listRuns: async () => [
          { id: "plan-1", status: "waiting_approval" },
          { id: "build-1", status: "running", planRunId: "plan-1" },
          { id: "other", status: "running", planRunId: "other-plan" },
        ],
      },
    )

    assert.deepEqual(calls, ["plan-1", "build-1"])
    assert.deepEqual(cancelled, ["plan-1", "build-1"])
  })

  it("closes a plan-to-build race discovered on the second list pass", async () => {
    const calls: string[] = []
    let listPass = 0
    await cancelCodexRunFamily(
      { projectId: "project-1", runId: "plan-1" },
      {
        cancelRun: async (runId) => { calls.push(runId) },
        listRuns: async () => {
          listPass += 1
          return listPass === 1
            ? [{ id: "plan-1", status: "cancelled" }]
            : [{ id: "build-late", status: "queued", planRunId: "plan-1" }]
        },
        settle: async () => {},
      },
    )

    assert.deepEqual(calls, ["plan-1", "build-late"])
  })

  it("continues child cancellation when the parent is already terminal or missing", async () => {
    const calls: string[] = []
    await cancelCodexRunFamily(
      { projectId: "project-1", runId: "plan-gone" },
      {
        cancelRun: async (runId) => {
          calls.push(runId)
          if (runId === "plan-gone") {
            throw Object.assign(new Error("run not found"), {
              status: 404,
              body: { error: "run_not_found" },
            })
          }
        },
        listRuns: async () => [
          { id: "build-active", status: "running", planRunId: "plan-gone" },
          { id: "build-done", status: "done", planRunId: "plan-gone" },
        ],
      },
    )

    assert.deepEqual(calls, ["plan-gone", "build-active"])
  })

  it("does not confirm an unrelated legacy 404 as an idempotent stop", async () => {
    let cancelCalls = 0
    await assert.rejects(
      cancelCodexRunFamily(
        { projectId: "project-1", runId: "run-1" },
        {
          cancelRun: async () => {
            cancelCalls += 1
            throw Object.assign(new Error("workspace not found"), {
              status: 404,
              body: { error: "workspace_not_found" },
            })
          },
          listRuns: async () => [],
        },
      ),
      /cancelación durable/i,
    )
    assert.equal(cancelCalls, 2)
  })

  it("retries a transient cancellation failure before confirming stop", async () => {
    const calls: string[] = []
    let attempt = 0
    const cancelled = await cancelCodexRunFamily(
      { projectId: "project-1", runId: "run-1" },
      {
        cancelRun: async (runId) => {
          calls.push(runId)
          attempt += 1
          if (attempt === 1) throw Object.assign(new Error("network down"), { status: 503 })
        },
        listRuns: async () => [],
      },
    )

    assert.deepEqual(calls, ["run-1", "run-1"])
    assert.deepEqual(cancelled, ["run-1"])
  })

  it("rejects when server cancellation cannot be confirmed", async () => {
    await assert.rejects(
      cancelCodexRunFamily(
        { projectId: "project-1", runId: "run-1" },
        {
          cancelRun: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }) },
          listRuns: async () => { throw Object.assign(new Error("offline"), { status: 503 }) },
        },
      ),
      /cancelación durable/i,
    )
  })

  it("atomically cancels a run whose create response arrives after the caller stopped", async () => {
    let releaseCreate!: (run: { id: string; status: string }) => void
    let stopped = false
    const familyCalls: string[] = []
    const createRun = () => new Promise<{ id: string; status: string }>((resolve) => {
      releaseCreate = resolve
    })

    const pending = createCodexRunWithCancellationFence({
      projectId: "project-late",
      createRun,
      isCancelled: () => stopped,
      cancelDeps: {
        cancelRun: async () => { throw new Error("single-run fallback must not be used") },
        cancelFamily: async (runId) => {
          familyCalls.push(runId)
          return { cancelledRunIds: [runId] }
        },
        listRuns: async () => { throw new Error("atomic endpoint must avoid list polling") },
      },
    })

    // Detener happens while POST /runs has no response/id yet.
    stopped = true
    releaseCreate({ id: "plan-created-late", status: "queued" })

    const result = await pending
    assert.equal(result.cancelled, true)
    assert.deepEqual(familyCalls, ["plan-created-late"])
    assert.equal(result.run.id, "plan-created-late")
  })

  it("keeps a delayed run active when the caller only detached its session", async () => {
    let releaseCreate!: (run: { id: string; status: string }) => void
    let detached = false
    let explicitlyStopped = false
    const familyCalls: string[] = []
    const pending = createCodexRunWithCancellationFence({
      projectId: "project-detached",
      createRun: () => new Promise<{ id: string; status: string }>((resolve) => { releaseCreate = resolve }),
      // Detach is intentionally not part of this predicate.
      isCancelled: () => explicitlyStopped,
      cancelDeps: {
        cancelRun: async () => {},
        cancelFamily: async (runId) => {
          familyCalls.push(runId)
          return { cancelledRunIds: [runId] }
        },
        listRuns: async () => [],
      },
    })

    detached = true
    releaseCreate({ id: "plan-still-active", status: "queued" })
    const result = await pending
    const recoverableTurn = {
      id: "assistant-old-session",
      codexRunId: result.run.id,
    }

    assert.equal(detached, true)
    assert.equal(explicitlyStopped, false)
    assert.equal(result.cancelled, false)
    assert.equal(result.run.status, "queued")
    assert.deepEqual(familyCalls, [])
    assert.equal(recoverableTurn.codexRunId, "plan-still-active")
  })
})
