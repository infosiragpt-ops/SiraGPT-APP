import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  beginCodexCancellationAttempt,
  canFinalizeCodexCancellation,
  classifyCodexCancellationReloadStatus,
  confirmCodexCancellationBackend,
  failCodexCancellationBackend,
  markCodexTurnCancelled,
  markCodexTurnCancellationFailed,
  markCodexTurnCancelling,
  patchCodexTurnUnlessCancellationLocked,
  reconcileCodexTurnAfterReload,
  selectCodexCancellationReloadRun,
  settleCodexCancellationEngine,
  type CodexCancellationTurn,
} from "../lib/codex/turn-cancellation"

function turn(overrides: Partial<CodexCancellationTurn> = {}): CodexCancellationTurn {
  return {
    id: "assistant-1",
    content: "Trabajo parcial",
    streaming: true,
    agentLabel: "Generando",
    ...overrides,
  }
}

describe("Codex turn cancellation presentation", () => {
  it("stays visually live while backend cancellation is pending", () => {
    const [pending] = markCodexTurnCancelling([turn()], "assistant-1")

    assert.equal(pending.cancellationState, "cancelling")
    assert.equal(pending.streaming, true)
    assert.equal(pending.agentLabel, "Deteniendo agente…")
    assert.equal(pending.content, "Trabajo parcial")
  })

  it("keeps a failed cancellation retryable instead of pretending it stopped", () => {
    const [failed] = markCodexTurnCancellationFailed(
      markCodexTurnCancelling([turn()], "assistant-1"),
      "assistant-1",
    )

    assert.equal(failed.cancellationState, "failed")
    assert.equal(failed.streaming, true)
    assert.match(failed.agentLabel || "", /reintenta/i)
  })

  it("becomes terminal only after confirmed cancellation", () => {
    const [cancelled] = markCodexTurnCancelled(
      markCodexTurnCancelling([turn()], "assistant-1"),
      "assistant-1",
    )

    assert.equal(cancelled.cancellationState, "cancelled")
    assert.equal(cancelled.streaming, false)
    assert.equal(cancelled.content, "_Generación detenida._")
  })

  it("blocks late engine patches for pending, failed and cancelled turns", () => {
    for (const cancellationState of ["cancelling", "failed", "cancelled"] as const) {
      const current = turn({ cancellationState })
      assert.strictEqual(
        patchCodexTurnUnlessCancellationLocked(current, {
          content: "Evento SSE tardío",
          agentLabel: "Turno completado",
          streaming: false,
        }),
        current,
      )
    }

    const active = turn()
    const updated = patchCodexTurnUnlessCancellationLocked(active, { content: "Evento válido" })
    assert.equal(updated.content, "Evento válido")
  })
})

describe("Codex durable cancellation coordination", () => {
  const target = { projectId: "project-1", runId: "run-1", turnId: "assistant-1" }

  it("waits for both engine settlement and backend confirmation", () => {
    const started = beginCodexCancellationAttempt({
      previous: null,
      attempt: 1,
      turnId: target.turnId,
      target,
    })

    assert.equal(canFinalizeCodexCancellation(started), false)
    assert.equal(
      canFinalizeCodexCancellation(confirmCodexCancellationBackend(started)),
      false,
    )
    assert.equal(
      canFinalizeCodexCancellation(settleCodexCancellationEngine(started)),
      false,
    )
    assert.equal(
      canFinalizeCodexCancellation(
        settleCodexCancellationEngine(confirmCodexCancellationBackend(started)),
      ),
      true,
    )
  })

  it("can finish locally only after the engine proves no durable run was created", () => {
    const started = beginCodexCancellationAttempt({
      previous: null,
      attempt: 2,
      turnId: target.turnId,
      target: null,
    })

    assert.equal(canFinalizeCodexCancellation(started), false)
    assert.equal(canFinalizeCodexCancellation(settleCodexCancellationEngine(started)), true)
  })

  it("preserves engine settlement across a failed backend attempt and retry", () => {
    const started = beginCodexCancellationAttempt({
      previous: null,
      attempt: 3,
      turnId: target.turnId,
      target,
    })
    const failed = failCodexCancellationBackend(settleCodexCancellationEngine(started))
    const retry = beginCodexCancellationAttempt({
      previous: failed,
      attempt: 4,
      turnId: target.turnId,
      target,
    })

    assert.equal(retry.engineSettled, true)
    assert.equal(retry.backendConfirmed, false)
    assert.equal(canFinalizeCodexCancellation(confirmCodexCancellationBackend(retry)), true)
  })

  it("retargets a late POST /runs response and keeps a failed fence non-terminal", () => {
    const stoppedBeforeCreateReturned = beginCodexCancellationAttempt({
      previous: null,
      attempt: 5,
      turnId: target.turnId,
      target: null,
    })
    const lateRun = beginCodexCancellationAttempt({
      previous: stoppedBeforeCreateReturned,
      attempt: 6,
      turnId: target.turnId,
      target,
    })
    const failedFence = failCodexCancellationBackend(
      settleCodexCancellationEngine(lateRun),
    )

    assert.deepEqual(failedFence.target, target)
    assert.equal(failedFence.status, "failed")
    assert.equal(failedFence.engineSettled, true)
    assert.equal(failedFence.backendConfirmed, false)
    assert.equal(canFinalizeCodexCancellation(failedFence), false)
  })
})

describe("Codex cancellation reload reconciliation", () => {
  it("turns a persisted pending bubble terminal when the backend run is cancelled", () => {
    const persisted = turn({ cancellationState: "cancelling", streaming: true })
    const restored = reconcileCodexTurnAfterReload(
      persisted,
      classifyCodexCancellationReloadStatus("cancelled"),
    )

    assert.equal(restored.cancellationState, "cancelled")
    assert.equal(restored.streaming, false)
    assert.equal(restored.agentLabel, "Generación detenida")
  })

  it("restores an active backend run as a retryable stop target", () => {
    const restored = reconcileCodexTurnAfterReload(
      turn({ cancellationState: "cancelling" }),
      classifyCodexCancellationReloadStatus("running"),
    )

    assert.equal(restored.cancellationState, "failed")
    assert.equal(restored.streaming, true)
    assert.match(restored.agentLabel || "", /reintenta detener/i)
  })

  it("prefers an auto-continued build over its persisted plan id", () => {
    const selected = selectCodexCancellationReloadRun(
      [
        { id: "plan-1", status: "cancelled", createdAt: "2026-08-05T10:00:00Z" },
        { id: "build-1", planRunId: "plan-1", status: "running", createdAt: "2026-08-05T10:00:01Z" },
      ],
      "plan-1",
    )

    assert.equal(selected?.id, "build-1")
    assert.equal(classifyCodexCancellationReloadStatus(selected?.status), "active")
  })

  it("makes done and error reloads terminal without claiming cancellation", () => {
    for (const status of ["done", "error"] as const) {
      const restored = reconcileCodexTurnAfterReload(
        turn({ cancellationState: "failed" }),
        classifyCodexCancellationReloadStatus(status),
      )
      assert.equal(restored.streaming, false)
      assert.equal(restored.cancellationState, undefined)
    }
  })
})
