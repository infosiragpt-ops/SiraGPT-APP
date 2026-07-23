import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentOfficeModel } from "../lib/agent-office-model"
import { AGENT_COMPANY_DEPARTMENTS } from "../lib/code-agent-company"
import type { CodeChatSession } from "../lib/code-chat-sessions"
import type { CodexRun } from "../lib/codex/codex-api"

function session(overrides: Partial<CodeChatSession> & Pick<CodeChatSession, "id" | "title">): CodeChatSession {
  return {
    id: overrides.id,
    workspaceId: "office-qa",
    title: overrides.title,
    turns: overrides.turns || [],
    createdAt: overrides.createdAt || 100,
    updatedAt: overrides.updatedAt || 200,
    agent: overrides.agent,
  }
}

function run(overrides: Partial<CodexRun> & Pick<CodexRun, "id" | "prompt" | "status">): CodexRun {
  return {
    id: overrides.id,
    projectId: "office-qa",
    mode: "build",
    status: overrides.status,
    tier: "pro",
    model: overrides.model || "gpt-5.4",
    planRunId: null,
    prompt: overrides.prompt,
    error: overrides.error || null,
    createdAt: overrides.createdAt || "2026-07-23T15:00:00.000Z",
    startedAt: overrides.startedAt || "2026-07-23T15:00:01.000Z",
    finishedAt: overrides.finishedAt || null,
  }
}

test("buildAgentOfficeModel maps real sessions and runs to departments and work states", () => {
  const sessions = [
    session({ id: "ceo", title: "CEO Office" }),
    session({
      id: "marketing",
      title: "Marketing",
      updatedAt: 300,
      turns: [{
        id: "turn-1",
        role: "assistant",
        content: "Publicando la campaña editorial de lanzamiento.",
        agentLabel: "Editora de campaña",
        streaming: true,
      }],
    }),
  ]
  const runs = [
    run({
      id: "trust-run",
      status: "running",
      prompt: "[PROACTIVO · Confianza, Privacidad y Cumplimiento] Auditar permisos del runner",
    }),
    run({
      id: "localization-run",
      status: "done",
      prompt: "[PROACTIVO · Localización e IA Transcultural] Adaptar el producto al portugués",
      finishedAt: "2026-07-23T15:10:00.000Z",
    }),
  ]

  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions,
    runs,
    rootSessionId: "ceo",
  })

  assert.equal(model.totalCount, 4)
  assert.equal(model.activeCount, 2)
  assert.equal(model.departments.length, AGENT_COMPANY_DEPARTMENTS.length)

  const marketing = model.workers.find((worker) => worker.sessionId === "marketing")
  assert.equal(marketing?.departmentId, "marketing")
  assert.equal(marketing?.activity, "publishing")
  assert.equal(marketing?.name, "Editora de campaña")
  assert.equal(marketing?.statusLabel, "Trabajando")

  const trust = model.workers.find((worker) => worker.runId === "trust-run")
  assert.equal(trust?.departmentId, "trust")
  assert.equal(trust?.activity, "security")
  assert.equal(trust?.active, true)
  assert.equal(trust?.task, "Auditar permisos del runner")

  const localization = model.workers.find((worker) => worker.runId === "localization-run")
  assert.equal(localization?.departmentId, "localization")
  assert.equal(localization?.statusTone, "ready")
})

test("buildAgentOfficeModel keeps empty departments without inventing workers", () => {
  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions: [],
    runs: [],
    rootSessionId: null,
  })

  assert.equal(model.totalCount, 0)
  assert.equal(model.activeCount, 0)
  assert.equal(model.departments.length, AGENT_COMPANY_DEPARTMENTS.length)
  assert.ok(model.departments.every((department) => department.workers.length === 0))
})
