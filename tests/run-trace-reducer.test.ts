import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { initialAgentState, reduceEvent, type AgentTaskState } from "../lib/agent-task-service"
import {
  collapseSuccessLabel,
  descriptionsDiffer,
  humanToolLabel,
  inferPhase,
  isStaleRun,
  projectStepRow,
  retryLabel,
  RUN_TRACE_STALE_MS,
  shouldRenderRunTrace,
  upsertMonotonicStep,
} from "../lib/run-trace"
import { toolToProfessionalLabel } from "../lib/agent-task-presentation"

function fresh(): AgentTaskState {
  return JSON.parse(JSON.stringify(initialAgentState))
}

describe("run-trace · human labels", () => {
  it("maps docintel variants to Spanish without leaking internals", () => {
    assert.equal(humanToolLabel("docintel.analyze"), "Leyendo el documento")
    assert.equal(humanToolLabel("docintel analyze"), "Leyendo el documento")
    assert.equal(humanToolLabel("docintel_analyze"), "Leyendo el documento")
    assert.equal(humanToolLabel("docintel retrieve"), "Consultando el documento")
    assert.equal(toolToProfessionalLabel("docintel analyze"), "Leyendo el documento")
    assert.equal(toolToProfessionalLabel("docintel_retrieve"), "Consultando el documento")
  })
})

describe("run-trace · reducer dedupe by step_id", () => {
  it("upserts the same step_id instead of appending a second row", () => {
    let state = fresh()
    state = reduceEvent(state, { type: "step_start", id: "s1", label: "Analizando solicitud" })
    state = reduceEvent(state, { type: "step_start", id: "s1", label: "Analizando solicitud" })
    assert.equal(state.steps.length, 1)
    assert.equal(state.steps[0].id, "s1")
  })

  it("accepts dotted aliases run.started / step.started / run.succeeded", () => {
    let state = fresh()
    state = reduceEvent(state, { type: "run.started", taskId: "t1", assistantMessageId: "msg-a" } as any)
    state = reduceEvent(state, { type: "step.started", id: "s1", label: "Leyendo el documento" } as any)
    state = reduceEvent(state, { type: "run.succeeded", stoppedReason: "finalized" } as any)
    assert.equal(state.meta?.assistantMessageId, "msg-a")
    assert.equal(state.steps.length, 1)
    assert.equal(state.done, true)
    assert.equal(state.error, undefined)
  })

  it("heartbeat refreshes lastEventAt without adding a step", () => {
    let state = fresh()
    state = reduceEvent(state, { type: "heartbeat", at: Date.now() } as any)
    assert.equal(state.steps.length, 0)
    assert.ok(state.lastEventAt)
    assert.ok(state.heartbeatAt)
  })
})

describe("run-trace · monotonic phases", () => {
  it("blocks regression from redactando back to sintetizando", () => {
    const steps = upsertMonotonicStep([], {
      id: "s1",
      label: "Preparando respuesta final",
      status: "running",
      retryCount: 1,
      toolCalls: [],
    })
    const next = upsertMonotonicStep(steps, {
      id: "s2",
      label: "Sintetizando evidencia",
      status: "running",
      retryCount: 1,
      toolCalls: [],
    })
    assert.equal(next.length, 1)
    assert.equal(next[0].id, "s1")
    assert.ok((next[0].retryCount || 1) >= 2)
    assert.equal(inferPhase({ label: "Preparando respuesta final" }), "redactando")
    assert.equal(inferPhase({ label: "Sintetizando evidencia" }), "sintetizando")
  })

  it("renders retries as Reintentando (n/3) not a new phase", () => {
    assert.equal(retryLabel("Sintetizando evidencia", 2), "Sintetizando evidencia · Reintentando (2/3)")
    const row = projectStepRow({
      id: "s1",
      label: "Sintetizando evidencia",
      status: "running",
      retryCount: 2,
      toolCalls: [],
    })
    assert.match(row.label, /Reintentando \(2\/3\)/)
  })
})

describe("run-trace · one row + assistant anchor", () => {
  it("hides description when it repeats the label", () => {
    assert.equal(descriptionsDiffer("Sintetizando evidencia", "Sintetizando evidencia"), false)
    const row = projectStepRow({
      id: "s1",
      label: "Sintetizando evidencia",
      status: "running",
      reasoning: "Sintetizando evidencia",
      toolCalls: [],
    })
    assert.equal(row.description, null)
  })

  it("renders only inside an assistant bubble, and only for the matching message id", () => {
    assert.equal(shouldRenderRunTrace({ role: "USER", messageId: "u1" }), false)
    assert.equal(shouldRenderRunTrace({ role: "ASSISTANT", messageId: "a1" }), true)
    assert.equal(shouldRenderRunTrace({
      role: "ASSISTANT",
      messageId: "a1",
      assistantMessageId: "a2",
    }), false)
    assert.equal(shouldRenderRunTrace({
      role: "ASSISTANT",
      messageId: "a2",
      assistantMessageId: "a2",
    }), true)
    assert.equal(shouldRenderRunTrace({
      role: "ASSISTANT",
      messageId: "cldbmessage001",
      assistantMessageId: "msg-assistant-processing-1",
    }), true)
  })

  it("collapses a succeeded run to a one-line duration", () => {
    assert.equal(collapseSuccessLabel(33), "Analizado en 33 s ✓")
  })

  it("marks a stream stale only after 3 missed heartbeats", () => {
    const now = Date.now()
    assert.equal(isStaleRun(new Date(now - 10_000).toISOString(), now), false)
    assert.equal(isStaleRun(new Date(now - RUN_TRACE_STALE_MS).toISOString(), now), true)
  })
})
