import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { initialAgentState, normalizeAgentTaskErrorMessage, reduceEvent } from "../lib/agent-task-service"

describe("agent-task-service · reducer", () => {
  it("keeps tool events under their matching step", () => {
    let state = reduceEvent(initialAgentState, {
      type: "meta",
      taskId: "task-frontend",
      goal: "Busca fuentes",
      model: "gpt-4o",
      tools: ["web_search"],
      intentAlignmentProfile: { groundingMode: "source_verification_required" },
      taskPlan: { phases: [{ id: "source_research" }] },
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
    assert.equal(state.meta?.model, "gpt-4o")
    assert.deepEqual(state.meta?.tools, ["web_search"])
    assert.equal(state.steps.length, 1)
    assert.equal(state.steps[0].toolCalls.length, 1)
    assert.equal(state.steps[0].toolCalls[0].output?.ok, true)
    assert.equal("preview" in state.steps[0].toolCalls[0], false)
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

describe("agent-task-service · error messages", () => {
  it("maps browser network fetch failures to an actionable backend restart message", () => {
    const message = normalizeAgentTaskErrorMessage(new TypeError("Failed to fetch"))

    assert.equal(
      message,
      "El backend se reinició o se perdió la conexión durante la tarea. Reintenta.",
    )
  })

  it("keeps known stream failures user-facing", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("idle_timeout")),
      "El asistente dejó de enviar actualizaciones. Reintenta el pedido.",
    )
  })

  it("maps 401 / unauthorized to session-expired copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("Request failed with status code 401")),
      "Tu sesión expiró. Inicia sesión de nuevo para continuar.",
    )
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("jwt expired")),
      "Tu sesión expiró. Inicia sesión de nuevo para continuar.",
    )
  })

  it("maps 429 / rate-limit to plan-limit copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("429 Too Many Requests")),
      "Has alcanzado el límite del plan. Espera unos minutos o actualiza tu plan.",
    )
  })

  it("maps 5xx to server-problem copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("502 Bad Gateway")),
      "El servidor tuvo un problema. Reintenta en unos segundos.",
    )
  })

  it("maps context-length and missing-model errors to actionable copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("This model's maximum context length is 8192 tokens")),
      "El mensaje superó el contexto del modelo. Acórtalo o divide la consulta.",
    )
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("Model gpt-foo not found")),
      "El modelo seleccionado no está disponible. Cámbialo desde el selector y reintenta.",
    )
  })

  it("downgrades aborted errors to a quiet status line", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("aborted")),
      "Tarea detenida.",
    )
  })

  it("handles undefined / null / empty input without throwing", () => {
    assert.equal(normalizeAgentTaskErrorMessage(undefined), "Agent task failed")
    assert.equal(normalizeAgentTaskErrorMessage(null), "Agent task failed")
    assert.equal(normalizeAgentTaskErrorMessage(""), "Agent task failed")
    // Plain object without a .message — String(err) → "[object Object]"
    // falls through unchanged because no friendly rule matches it.
    assert.equal(normalizeAgentTaskErrorMessage({} as any), "[object Object]")
  })

  it("passes through unknown error strings verbatim", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("OCR pipeline could not detect text")),
      "OCR pipeline could not detect text",
    )
  })

  it("is case-insensitive for the friendly-remap patterns", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("FAILED TO FETCH")),
      "El backend se reinició o se perdió la conexión durante la tarea. Reintenta.",
    )
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("REDIS connection refused")),
      "Runtime agentico no disponible: Redis no está activo.",
    )
  })
})
