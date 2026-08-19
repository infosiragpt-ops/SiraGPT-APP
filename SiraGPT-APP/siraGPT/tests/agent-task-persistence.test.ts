import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const cjsRequire = createRequire(__filename)

const persistence = cjsRequire("../../backend/src/services/agents/agent-task-persistence") as {
  INTERNAL: {
    buildExistingTaskLookup: (data: Record<string, unknown>) => Record<string, unknown>
    isTerminalStatus: (status?: string) => boolean
    stateFromEvent: (state: Record<string, unknown> | null, event: Record<string, unknown>) => Record<string, unknown> | null
    statusFromEvent: (event: Record<string, unknown>, fallback?: string) => string
    withTerminalTimestamps: (data: Record<string, unknown>, task?: Record<string, unknown>) => Record<string, unknown>
  }
}

describe("agent-task-persistence", () => {
  it("deriva estado completed cuando llega un evento done", () => {
    assert.equal(
      persistence.INTERNAL.statusFromEvent({ type: "done", stoppedReason: "vancouver_matrix_docx" }, "running"),
      "completed",
    )
    assert.equal(
      persistence.INTERNAL.statusFromEvent({ type: "done", stoppedReason: "aborted" }, "running"),
      "cancelled",
    )
  })

  it("marca el state persistido como done para que la UI deje de pensar", () => {
    const state = persistence.INTERNAL.stateFromEvent(
      { steps: [], done: false },
      { type: "done", stoppedReason: "vancouver_matrix_docx" },
    )

    assert.equal(state?.done, true)
    assert.equal(state?.stoppedReason, "vancouver_matrix_docx")
  })

  it("agrega timestamps terminales sin depender del caller", () => {
    const data = persistence.INTERNAL.withTerminalTimestamps({
      status: "completed",
      completedAt: null,
    })

    assert.equal(persistence.INTERNAL.isTerminalStatus("completed"), true)
    assert.ok(data.completedAt instanceof Date)
  })

  it("busca tareas existentes por id y jobId antes de crear", () => {
    assert.deepEqual(
      persistence.INTERNAL.buildExistingTaskLookup({ id: "task-1", jobId: "job-1" }),
      { OR: [{ id: "task-1" }, { jobId: "job-1" }] },
    )

    assert.deepEqual(
      persistence.INTERNAL.buildExistingTaskLookup({ id: "task-1", jobId: "task-1" }),
      { id: "task-1" },
    )
  })
})
