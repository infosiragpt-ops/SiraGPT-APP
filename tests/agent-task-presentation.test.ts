import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  formatQualityScore,
  professionalStepLabel,
  sanitizeAgentText,
  summarizeAgentActivity,
} from "../lib/agent-task-presentation"
import type { AgentTaskState } from "../lib/agent-task-service"

describe("agent-task-presentation · professional UI projection", () => {
  it("hides technical command and JSON text from user-facing labels", () => {
    assert.equal(sanitizeAgentText('{"taskId":"3","status":"completed"}', "Procesando tarea"), "Procesando tarea")
    assert.equal(sanitizeAgentText("Ejecutando comando: python script.py", "Procesando tarea"), "Procesando tarea")
  })

  it("maps raw tool execution into professional activity names", () => {
    const label = professionalStepLabel({
      id: "s1",
      label: "Ejecutando comando",
      icon: "bash",
      status: "running",
      toolCalls: [{ tool: "python_exec", preview: "python script.py", language: "python" }],
    })

    assert.equal(label, "Procesando datos")
    assert.equal(professionalStepLabel({ id: "s2", label: "run_tests", status: "done", toolCalls: [] }), "Ejecutando validaciones")
    assert.equal(sanitizeAgentText("run_tests", "Progreso guardado"), "Ejecutando validaciones")
  })

  it("formats validation scores whether they arrive as ratios or percentages", () => {
    assert.equal(formatQualityScore(0.94), "94%")
    assert.equal(formatQualityScore(94), "94%")
    assert.equal(formatQualityScore(142), "100%")
  })

  it("summarizes steps, tools, validations and repairs without exposing payloads", () => {
    const state: AgentTaskState = {
      steps: [
        {
          id: "s1",
          label: "Buscar fuentes",
          status: "done",
          toolCalls: [{ tool: "web_search", preview: "query" }],
        },
        {
          id: "s2",
          label: "Verificar",
          status: "running",
          toolCalls: [{ tool: "verify_artifact", preview: '{"raw":true}' }],
        },
      ],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [{ id: "q1", label: "slides", passed: true }],
      repairs: [],
      finalText: "",
      done: false,
    }

    const summary = summarizeAgentActivity(state)
    assert.equal(summary.status, "verifying")
    assert.equal(summary.stepCount, 2)
    assert.equal(summary.toolCount, 2)
    assert.equal(summary.validationPassed, 1)
    assert.equal(summary.validationTotal, 1)
  })
})
