import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { agentTaskStateToUiMessage } from "../lib/agent-task-ai-sdk-bridge"
import { initialAgentState, reduceEvent } from "../lib/agent-task-service"

describe("agent task AI SDK bridge", () => {
  it("keeps framework and approval events in client state", () => {
    let state = reduceEvent(initialAgentState, {
      type: "framework_status",
      version: "test",
      active: { orchestration: "langgraph", uiStreamBridge: "vercel-ai-sdk" },
      frameworks: { langgraph: { enabled: true } },
      observability: { traceExport: "local-events" },
    })
    state = reduceEvent(state, {
      type: "human_approval_required",
      approvalId: "approval-1",
      tool: "create_document",
      action: "write_file",
      reason: "High-impact tool gate",
    })
    state = reduceEvent(state, {
      type: "human_approval_resolved",
      approvalId: "approval-1",
      decision: "approve",
      resolvedBy: "user-1",
    })

    assert.equal((state.frameworks?.active as any).orchestration, "langgraph")
    assert.equal(state.approvals.length, 1)
    assert.equal(state.approvals[0].status, "approve")
  })

  it("maps AgentTaskState to a UIMessage-compatible shape", () => {
    const state = {
      ...initialAgentState,
      finalText: "Documento listo",
      meta: { taskId: "task-ui", goal: "Crear reporte", model: "gpt-4o", tools: [] },
    }
    const msg = agentTaskStateToUiMessage(state, "task-ui")

    assert.equal(msg.id, "task-ui")
    assert.equal(msg.role, "assistant")
    assert.equal(msg.parts[0].type, "text")
    assert.equal((msg.parts[0] as any).text, "Documento listo")
    assert.equal(msg.parts[1].type, "data-agent-task")
  })
})
