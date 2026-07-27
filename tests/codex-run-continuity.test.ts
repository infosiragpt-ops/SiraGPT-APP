import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { CodexRun } from "../lib/codex/codex-api"
import {
  codexContinuityStreamTerminalStatuses,
  selectCodexContinuityAssistantTurn,
  selectCodexContinuityRun,
  upsertCodexContinuityTurn,
} from "../lib/codex/run-continuity"

function run(
  id: string,
  mode: "plan" | "build",
  status: string,
  createdAt: string,
  autoExecute = true,
  planRunId: string | null = null,
): CodexRun {
  return {
    id,
    projectId: "project-1",
    mode,
    status,
    tier: null,
    model: null,
    planRunId,
    prompt: "Construye la app",
    autoExecute,
    error: null,
    createdAt,
    startedAt: null,
    finishedAt: status === "done" ? createdAt : null,
  }
}

describe("Codex chat continuity", () => {
  it("prefers an active build over its waiting plan", () => {
    const selected = selectCodexContinuityRun([
      run("build-1", "build", "running", "2026-07-25T12:01:00Z"),
      run("plan-1", "plan", "waiting_approval", "2026-07-25T12:00:00Z"),
    ])
    assert.equal(selected?.id, "build-1")
  })

  it("recovers an auto-executable waiting plan without touching human-gated runs", () => {
    const selected = selectCodexContinuityRun([
      run("human-plan", "plan", "waiting_approval", "2026-07-25T12:02:00Z", false),
      run("auto-plan", "plan", "waiting_approval", "2026-07-25T12:01:00Z"),
    ])
    assert.equal(selected?.id, "auto-plan")
  })

  it("rehydrates a waiting build as the active run", () => {
    const selected = selectCodexContinuityRun([
      run("plan-1", "plan", "waiting_approval", "2026-07-25T12:00:00Z"),
      run(
        "build-1",
        "build",
        "waiting_approval",
        "2026-07-25T12:01:00Z",
        true,
        "plan-1",
      ),
    ])
    assert.equal(selected?.id, "build-1")
  })

  it("pulls the newest unsynchronized completed build only once", () => {
    const runs = [
      run("build-new", "build", "done", "2026-07-25T12:02:00Z"),
      run("build-old", "build", "done", "2026-07-25T12:01:00Z"),
    ]
    assert.equal(selectCodexContinuityRun(runs, "build-old")?.id, "build-new")
    assert.equal(selectCodexContinuityRun(runs, "build-new"), null)
  })

  it("does not replay a waiting plan after its completed build was synchronized", () => {
    const runs = [
      run("build-1", "build", "done", "2026-07-25T12:01:00Z", true, "plan-1"),
      run("plan-1", "plan", "waiting_approval", "2026-07-25T12:00:00Z"),
    ]
    assert.equal(selectCodexContinuityRun(runs)?.id, "build-1")
    assert.equal(selectCodexContinuityRun(runs, "build-1"), null)
  })

  it("keeps waiting_approval terminal only for plan streams", () => {
    assert.deepEqual(codexContinuityStreamTerminalStatuses("plan"), [
      "done",
      "error",
      "cancelled",
      "waiting_approval",
    ])
    assert.deepEqual(codexContinuityStreamTerminalStatuses("build"), [
      "done",
      "error",
      "cancelled",
    ])
  })

  it("reuses the durable or legacy streaming assistant turn without duplicating it", () => {
    const turns = [
      { id: "user-1", role: "user" as const, content: "Construye la app" },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Trabajando",
        streaming: true,
        codexRunId: "plan-1",
      },
    ]
    const selected = selectCodexContinuityAssistantTurn(
      turns,
      "build-1",
      "plan-1",
    )
    assert.equal(selected?.id, "assistant-1")

    const next = upsertCodexContinuityTurn(
      turns,
      {
        id: selected?.id || "assistant-new",
        role: "assistant" as const,
        content: "Retomando",
        streaming: true,
        codexRunId: "build-1",
      },
      selected?.id,
    )
    assert.equal(next.length, turns.length)
    assert.equal(next.filter((turn) => turn.role === "assistant").length, 1)
    assert.equal(next[1]?.codexRunId, "build-1")
    assert.equal(next[1]?.content, "Retomando")
  })

  it("falls back to the newest legacy streaming assistant turn", () => {
    const turns = [
      { id: "assistant-old", role: "assistant" as const, streaming: true },
      { id: "assistant-new", role: "assistant" as const, streaming: true },
    ]
    assert.equal(
      selectCodexContinuityAssistantTurn(turns, "build-1")?.id,
      "assistant-new",
    )
  })
})
