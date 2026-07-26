import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { CodexRun } from "../lib/codex/codex-api"
import { selectCodexContinuityRun } from "../lib/codex/run-continuity"

function run(
  id: string,
  mode: "plan" | "build",
  status: string,
  createdAt: string,
  autoExecute = true,
): CodexRun {
  return {
    id,
    projectId: "project-1",
    mode,
    status,
    tier: null,
    model: null,
    planRunId: null,
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

  it("pulls the newest unsynchronized completed build only once", () => {
    const runs = [
      run("build-new", "build", "done", "2026-07-25T12:02:00Z"),
      run("build-old", "build", "done", "2026-07-25T12:01:00Z"),
    ]
    assert.equal(selectCodexContinuityRun(runs, "build-old")?.id, "build-new")
    assert.equal(selectCodexContinuityRun(runs, "build-new"), null)
  })
})
