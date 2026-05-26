import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AgentTaskState } from "../lib/agent-task-service"
import {
  formatQualityScore,
  professionalStepLabel,
  sanitizeAgentText,
  summarizeAgentActivity,
  toolToProfessionalLabel,
} from "../lib/agent-task-presentation"

/**
 * The base suite at tests/agent-task-presentation.test.ts already
 * covers the happy paths. This file fills in the edge cases — empty /
 * malformed inputs, range bounds for the quality score, status
 * collision resolution in summarizeAgentActivity, etc.
 */

describe("formatQualityScore · range bounds", () => {
  it("normalises a 0..1 ratio to a percentage", () => {
    assert.equal(formatQualityScore(0), "0%")
    assert.equal(formatQualityScore(0.5), "50%")
    assert.equal(formatQualityScore(1), "100%")
  })

  it("leaves a > 1 value alone (already a percent)", () => {
    assert.equal(formatQualityScore(72), "72%")
    assert.equal(formatQualityScore(99.7), "100%")
  })

  it("clamps below 0 and above 100", () => {
    assert.equal(formatQualityScore(-5), "0%")
    assert.equal(formatQualityScore(150), "100%")
    // Edge: any score > 1 is treated as a literal percent, so 1.5
    // becomes 2% (rounded from 1.5%), NOT 100%. Pin this so a future
    // "smarter" interpretation surfaces here intentionally.
    assert.equal(formatQualityScore(1.5), "2%")
  })
})

describe("toolToProfessionalLabel · null / unknown tools", () => {
  it("returns a generic label when tool is null / undefined / empty", () => {
    assert.equal(toolToProfessionalLabel(null), "Procesando tarea")
    assert.equal(toolToProfessionalLabel(undefined), "Procesando tarea")
    assert.equal(toolToProfessionalLabel(""), "Procesando tarea")
  })

  it("titlecases unknown tools by replacing _ / - with spaces", () => {
    // Unknown tool falls through to sanitizeAgentText, which keeps the
    // de-underscored form unless it looks technical.
    assert.equal(
      toolToProfessionalLabel("custom-prepare-step"),
      "custom prepare step",
    )
  })

  it("maps a known tool to its Spanish label", () => {
    assert.equal(toolToProfessionalLabel("web_search"), "Buscando fuentes")
    assert.equal(toolToProfessionalLabel("python_exec"), "Procesando datos")
  })
})

describe("sanitizeAgentText · technical / structural guard", () => {
  it("returns the fallback for raw JSON payloads", () => {
    assert.equal(sanitizeAgentText(`{"tool": "web_search"}`), "Procesando tarea")
  })

  it("returns the fallback for snake_case tool tokens", () => {
    assert.equal(sanitizeAgentText("self_rag_answer"), "Sintetizando evidencia")
    assert.equal(sanitizeAgentText("custom_tool_run"), "Procesando tarea")
  })

  it("returns the fallback for technical keywords (curl, traceback, etc.)", () => {
    assert.equal(sanitizeAgentText("ejecutando comando python"), "Procesando tarea")
    assert.equal(sanitizeAgentText("Traceback (most recent call last)"), "Procesando tarea")
  })

  it("ellipsises long descriptions over 92 chars", () => {
    const long =
      "Analizando la solicitud del usuario para preparar un plan detallado de respuestas y acciones encadenadas que aseguren cobertura"
    const out = sanitizeAgentText(long)
    assert.equal(out.endsWith("..."), true)
    assert.ok(out.length <= 92 + 3)
  })

  it("collapses internal whitespace to single spaces", () => {
    assert.equal(sanitizeAgentText("Analizando   \n  solicitud"), "Analizando solicitud")
  })

  it("returns the configured fallback when value is null / empty", () => {
    assert.equal(sanitizeAgentText(null, "Listo"), "Listo")
    assert.equal(sanitizeAgentText("", "Listo"), "Listo")
    assert.equal(sanitizeAgentText(undefined), "Procesando tarea")
  })
})

describe("professionalStepLabel · regex fallbacks", () => {
  const mk = (label: string, tool?: string) => ({
    id: "s1",
    label,
    status: "running",
    toolCalls: tool ? [{ tool }] : [],
  }) as any

  it("prefers the tool label when a tool call exists", () => {
    assert.equal(professionalStepLabel(mk("anything", "web_search")), "Buscando fuentes")
  })

  it("falls back to analysis copy when label mentions plan/analy", () => {
    assert.equal(professionalStepLabel(mk("plan inicial")), "Analizando solicitud")
    assert.equal(professionalStepLabel(mk("analyzing context")), "Analizando solicitud")
  })

  it("falls back to data-processing copy for sandbox/code/calc labels", () => {
    assert.equal(professionalStepLabel(mk("running sandbox")), "Procesando datos")
    assert.equal(professionalStepLabel(mk("calc summary")), "Procesando datos")
  })

  it("falls back to document copy for file/document labels", () => {
    assert.equal(professionalStepLabel(mk("preparing docx")), "Generando documento")
    assert.equal(professionalStepLabel(mk("ppt slides ready")), "Generando documento")
  })

  it("falls back to validation copy for verify/quality labels", () => {
    assert.equal(professionalStepLabel(mk("verify outputs")), "Verificando entrega")
    assert.equal(professionalStepLabel(mk("quality gate run")), "Verificando entrega")
  })

  it("falls back to repair copy for repair/regen labels", () => {
    // Order matters: earlier regex slots win, so a label has to avoid
    // those tokens. "repair plan" hits /plan/ first; "regenerating
    // docx" hits /docx/ first. Use isolated repair-only labels here.
    assert.equal(professionalStepLabel(mk("repair workflow")), "Corrigiendo entrega")
    assert.equal(professionalStepLabel(mk("regen output")), "Corrigiendo entrega")
  })

  it("falls back to final-prep copy for final/resumen labels", () => {
    assert.equal(professionalStepLabel(mk("final summary")), "Preparando respuesta final")
    assert.equal(professionalStepLabel(mk("listo para entrega")), "Preparando respuesta final")
  })
})

describe("summarizeAgentActivity · status precedence", () => {
  const emptyState = (): AgentTaskState =>
    ({
      steps: [],
      qualityGates: [],
      repairs: [],
      checkpoints: [],
      queue: undefined,
      done: false,
      error: null,
    } as any)

  it("returns 'idle' for a brand-new empty state", () => {
    const s = summarizeAgentActivity(emptyState())
    assert.equal(s.status, "idle")
    assert.equal(s.stepCount, 0)
    assert.equal(s.toolCount, 0)
  })

  it("'cancelled' beats any other state when error === 'aborted'", () => {
    const state = emptyState() as any
    state.error = "aborted"
    state.done = true // would normally win, but cancelled is precedence-stronger
    const s = summarizeAgentActivity(state)
    assert.equal(s.status, "cancelled")
  })

  it("non-aborted errors come through as 'error'", () => {
    const state = emptyState() as any
    state.error = "Internal Server Error"
    const s = summarizeAgentActivity(state)
    assert.equal(s.status, "error")
  })

  it("'completed' wins over 'queued' if done flag is set", () => {
    const state = emptyState() as any
    state.done = true
    state.queue = { status: "queued" }
    const s = summarizeAgentActivity(state)
    assert.equal(s.status, "completed")
  })

  it("counts unique tools across steps", () => {
    const state = emptyState() as any
    state.steps = [
      { id: "1", toolCalls: [{ tool: "web_search" }, { tool: "web_search" }] },
      { id: "2", toolCalls: [{ tool: "python_exec" }] },
    ]
    const s = summarizeAgentActivity(state)
    assert.equal(s.toolCount, 2)
  })

  it("derives stepCount from the larger of steps / checkpoints", () => {
    const state = emptyState() as any
    state.steps = [{ id: "1" }, { id: "2" }]
    state.checkpoints = [{ id: "c1" }, { id: "c2" }, { id: "c3" }]
    const s = summarizeAgentActivity(state)
    assert.equal(s.stepCount, 3)
  })

  it("counts passed validations correctly", () => {
    const state = emptyState() as any
    state.qualityGates = [
      { passed: true },
      { passed: false },
      { passed: true },
    ]
    const s = summarizeAgentActivity(state)
    assert.equal(s.validationTotal, 3)
    assert.equal(s.validationPassed, 2)
  })

  it("'repairing' status fires when the latest repair is not yet completed", () => {
    const state = emptyState() as any
    state.repairs = [
      { attempt: 1, status: "completed" },
      { attempt: 2, status: "running" }, // latest = still in flight
    ]
    const s = summarizeAgentActivity(state)
    assert.equal(s.status, "repairing")
  })

  it("'repairing' does NOT fire when the latest repair is completed", () => {
    const state = emptyState() as any
    state.repairs = [
      { attempt: 1, status: "completed" },
      { attempt: 2, status: "completed" },
    ]
    const s = summarizeAgentActivity(state)
    // No other status drivers -> idle.
    assert.equal(s.status, "idle")
  })

  it("'verifying' fires when qualityGates exist AND a step is still running", () => {
    const state = emptyState() as any
    state.qualityGates = [{ passed: true }]
    state.steps = [{ id: "s1", status: "running", toolCalls: [] }]
    const s = summarizeAgentActivity(state)
    assert.equal(s.status, "verifying")
  })
})
