import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { initialAgentState, reduceEvent } from "../lib/agent-task-service"

describe("agent-task-service · reducer", () => {
  it("keeps tool events under their matching step", () => {
    let state = reduceEvent(initialAgentState, {
      type: "meta",
      taskId: "task-frontend",
      goal: "Busca fuentes",
      model: "gpt-4o",
      tools: ["web_search"],
      intentAlignmentProfile: { groundingMode: "source_verification_required" },
    })
    state = reduceEvent(state, {
      type: "step_start",
      id: "s1",
      label: "Buscar fuentes",
      icon: "search",
    })
    state = reduceEvent(state, {
      type: "tool_call",
      stepId: "s1",
      tool: "web_search",
      preview: "diabetes prevention papers",
    })
    state = reduceEvent(state, {
      type: "tool_output",
      stepId: "s1",
      tool: "web_search",
      ok: true,
      preview: "25 fuentes",
    })

    assert.equal(state.meta?.taskId, "task-frontend")
    assert.equal(state.meta?.intentAlignmentProfile?.groundingMode, "source_verification_required")
    assert.equal(state.steps.length, 1)
    assert.equal(state.steps[0].toolCalls.length, 1)
    assert.equal(state.steps[0].toolCalls[0].output?.preview, "25 fuentes")
  })

  it("does not drop tool events if a stale stream emits them before step_start", () => {
    const state = reduceEvent(initialAgentState, {
      type: "tool_call",
      stepId: "s-late",
      tool: "python_exec",
      preview: "print('ok')",
      language: "python",
    })

    assert.equal(state.steps.length, 1)
    assert.equal(state.steps[0].id, "s-late")
    assert.equal(state.steps[0].toolCalls[0].tool, "python_exec")
  })
})
