import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { agentTaskStateToUiMessage, loadVercelAiSdkBridge } from "../lib/agent-task-ai-sdk-bridge"
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

  it("loads the Vercel AI SDK bridge packages from the frontend workspace", async () => {
    const bridge = await loadVercelAiSdkBridge()

    assert.equal(bridge.ready, true)
    assert.ok(bridge.exports.ai.length > 0)
    assert.ok(bridge.exports.openai.length > 0)
    assert.ok(bridge.exports.langchain.length > 0)
    assert.ok(bridge.exports.react.length > 0)
  })

  it("agentTaskStateToUiMessage falls back to error when finalText is empty", () => {
    const state = {
      ...initialAgentState,
      finalText: "",
      error: "Stream closed without done",
    }
    const msg = agentTaskStateToUiMessage(state, "task-err")
    assert.equal((msg.parts[0] as any).text, "Stream closed without done")
  })

  it("agentTaskStateToUiMessage falls back to last step label when finalText + error are empty", () => {
    const state = {
      ...initialAgentState,
      finalText: "",
      steps: [
        { id: "s1", label: "Analizando solicitud", status: "done", toolCalls: [] },
        { id: "s2", label: "Generando documento", status: "running", toolCalls: [] },
      ] as any,
    }
    const msg = agentTaskStateToUiMessage(state, "task-step")
    assert.equal((msg.parts[0] as any).text, "Generando documento")
  })

  it("agentTaskStateToUiMessage falls back to 'Agent task running' when everything is empty", () => {
    const msg = agentTaskStateToUiMessage(initialAgentState, "task-empty")
    assert.equal((msg.parts[0] as any).text, "Agent task running")
  })

  it("agentTaskStateToUiMessage defaults id to meta.taskId when not supplied", () => {
    const state = {
      ...initialAgentState,
      finalText: "ok",
      meta: { taskId: "task-from-meta", goal: "g", model: "m", tools: [] },
    } as any
    const msg = agentTaskStateToUiMessage(state)
    assert.equal(msg.id, "task-from-meta")
  })

  it("agentTaskStateToUiMessage uses 'agent-task' when meta + explicit id are both missing", () => {
    const msg = agentTaskStateToUiMessage(initialAgentState)
    assert.equal(msg.id, "agent-task")
  })
})
