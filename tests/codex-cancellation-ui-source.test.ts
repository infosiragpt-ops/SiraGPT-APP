import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("/code durable cancellation UI contract", () => {
  it("keeps a Codex turn live until the double confirmation gate passes", () => {
    const cancellationFlow = sliceBetween(
      "const finalizeCodexCancellation",
      "// runCodexEngine is defined AFTER sendPrompt",
    )

    assert.match(cancellationFlow, /!canFinalizeCodexCancellation\(candidate\)/)
    assert.match(cancellationFlow, /markCodexTurnCancelling\(prev, turnId\)/)
    assert.match(cancellationFlow, /markCodexTurnCancellationFailed\(prev, turnId\)/)
    assert.match(cancellationFlow, /markCodexTurnCancelled\(prev, candidate\.turnId\)/)
    assert.match(cancellationFlow, /existingCancellation\?\.status === "cancelling"/)
    assert.match(cancellationFlow, /existingCancellation\?\.status === "failed"[\s\S]*?existingCancellation\.target/)
  })

  it("retargets a stop that landed before POST /runs returned", () => {
    const lateCreateFence = sliceBetween(
      "if (created.cancelled) {",
      "planRun = created.run",
    )

    assert.match(lateCreateFence, /const target = \{ projectId, runId: created\.run\.id, turnId: assistantId \}/)
    assert.match(lateCreateFence, /beginCodexCancellation\(assistantId, target\)/)
    assert.match(lateCreateFence, /recordCodexEngineSettled\(assistantId, attempt\)/)
    assert.match(lateCreateFence, /created\.cancellationError[\s\S]*?recordCodexCancellationFailure/)
    assert.match(lateCreateFence, /else \{[\s\S]*?recordCodexBackendConfirmation/)
    assert.doesNotMatch(lateCreateFence, /finishStopped\(\)/)
  })

  it("locks late SSE and terminal patches after cancellation takes ownership", () => {
    const engine = sliceBetween(
      "const runCodexEngine = React.useCallback",
      "// Keep the resilience-fallback ref",
    )

    assert.match(engine, /if \(isCodexTurnCancellationLocked\(t\)\) return t/)
    assert.match(engine, /patchCodexTurnUnlessCancellationLocked\(t, \{[\s\S]*?agentLabel: label/)
    assert.match(engine, /onEvent: \(ev\) => \{\s*if \(cancelledTurn\(\)\) return/)
    assert.match(engine, /onStatus: \(status\) => \{\s*if \(cancelledTurn\(\)\) return/)
  })

  it("exposes pending and retryable stop states in the composer", () => {
    assert.match(source, /disabled=\{activeCodexCancellationState === "cancelling"\}/)
    assert.match(source, /"Reintentar detención"/)
    assert.match(source, /<Loader2 className="h-4 w-4 animate-spin" \/>/)
  })

  it("reconciles a persisted cancellation with its durable run before continuity", () => {
    const continuity = sliceBetween(
      "// Reload/close continuity",
      "const dispatch = React.useCallback",
    )

    assert.match(continuity, /selectCodexCancellationReloadRun\(runs, turn\.codexRunId\)/)
    assert.match(continuity, /reconcileCodexTurnAfterReload\(turn, result\.kind\)/)
    assert.match(continuity, /result\.kind === "cancelled"/)
    assert.match(continuity, /result\.kind === "active"/)
    assert.match(continuity, /beginCodexCancellation\(activeCancellation\.turn\.id, target\)/)
    assert.match(continuity, /recordCodexCancellationFailure\(activeCancellation\.turn\.id, attempt\)/)
  })

  it("keeps the composer locked while a durable cancellation is unresolved", () => {
    const watchdog = sliceBetween(
      "// Stale-busy watchdog",
      "// Stale-build watchdog",
    )

    assert.match(
      watchdog,
      /if \(!abortRef\.current && !codexCancellationRef\.current\)/,
    )
  })

  it("distinguishes explicit Stop from session detach around delayed run creation", () => {
    const engine = sliceBetween(
      "const runCodexEngine = React.useCallback",
      "// Keep the resilience-fallback ref",
    )

    assert.match(engine, /const explicitlyStoppedTurn = \(\) => explicitCodexStopTurnIdsRef\.current\.has\(assistantId\)/)
    assert.match(engine, /isCancelled: explicitlyStoppedTurn/)
    assert.match(
      engine,
      /if \(!explicitlyStoppedTurn\(\)\) \{[\s\S]*?persistAssistantRunId\(planRun\.id\)[\s\S]*?return/,
    )
    assert.match(engine, /persistAssistantRunId\(created\.run\.id\)/)
  })
})
