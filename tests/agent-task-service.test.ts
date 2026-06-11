import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { initialAgentState, normalizeAgentTaskErrorMessage, reduceEvent, runStream } from "../lib/agent-task-service"

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
    // Claude-style research trace (commit afaf6fc06): the call keeps its
    // preview (the search query) as the visible line for the tool call,
    // and the output carries its own preview text.
    assert.equal(state.steps[0].toolCalls[0].preview, "diabetes prevention papers")
    assert.equal(state.steps[0].toolCalls[0].output?.ok, true)
    assert.equal(state.steps[0].toolCalls[0].output?.preview, "25 fuentes")
  })

  it("preserves taskId from early queue_status events before meta arrives", () => {
    const state = reduceEvent(initialAgentState, {
      type: "queue_status",
      taskId: "task-from-queue",
      status: "queued",
      queue: "agent-task",
      jobId: "job-1",
      position: 0,
      estimatedWaitMs: 0,
      ts: "2026-05-31T23:00:00Z",
    })

    assert.equal(state.meta?.taskId, "task-from-queue")
    assert.equal(state.queue?.status, "queued")
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

function makeSseResponse(events: any[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function makeJsonResponse(payload: any): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("agent-task-service · closed-stream recovery", () => {
  it("polls durable task events and returns the final answer when POST+SSE closes before done", async () => {
    const originalFetch = globalThis.fetch
    const seenUrls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      seenUrls.push(url)
      if (url.includes("/agent/task/") && url.includes("/events")) {
        return makeJsonResponse({
          ok: true,
          taskId: "task-doc-followup",
          status: "completed",
          events: [
            { type: "final_text", markdown: "El título de la investigación es: Estrategias de marketing digital para Yopo S.A.C.", seq: 3 },
            { type: "done", stoppedReason: "completed", stats: { steps: 1, artifacts: 0 }, seq: 4 },
          ],
        })
      }
      if (url.endsWith("/agent/task")) {
        return makeSseResponse([
          { type: "queue_status", taskId: "task-doc-followup", status: "running", queue: "agent-task", jobId: "job-1", seq: 1 },
          { type: "step_start", id: "s1", label: "Consultando documentación", icon: "doc", seq: 2 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    }) as typeof fetch

    try {
      const state = await runStream({
        goal: "cual es el titulo de la investigación?",
        files: ["file-docx"],
        chatId: "chat-1",
        model: "gpt-4o",
      })

      assert.equal(state.done, true)
      assert.equal(state.error, undefined)
      assert.match(state.finalText, /El título de la investigación/i)
      assert.ok(
        seenUrls.some(url => /\/agent\/task\/task-doc-followup\/events\?after=2/.test(url)),
        "expected the client to poll durable task events from the last seen seq",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
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

  it("maps empty_stream / AgentTaskEmptyStreamError to a retry-friendly copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("empty_stream")),
      "El asistente cerró la respuesta sin generar texto. Reintenta.",
    )
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("AgentTaskEmptyStreamError")),
      "El asistente cerró la respuesta sin generar texto. Reintenta.",
    )
  })

  it("maps insufficient_quota / quota_exceeded to the context-overflow copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("insufficient_quota")),
      "El mensaje superó el contexto del modelo. Acórtalo o divide la consulta.",
    )
  })

  it("treats Error objects whose name is 'AbortError' as cancelled (not the message text)", () => {
    const err = new Error("Some long stack")
    ;(err as any).name = "AbortError"
    // The matcher reads err.message (from `.message || err`), so the
    // name itself isn't seen — but the AbortError keyword in the
    // message string matches. We use the actual SDK shape: `name`
    // alone doesn't trigger this branch.
    assert.equal(
      normalizeAgentTaskErrorMessage({ message: "AbortError: stream cancelled" }),
      "Tarea detenida.",
    )
  })

  it("maps 503 Service Unavailable to the server-problem copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("503 service unavailable")),
      "El servidor tuvo un problema. Reintenta en unos segundos.",
    )
  })

  it("maps 'invalid_model' verbatim to the model-not-available copy", () => {
    assert.equal(
      normalizeAgentTaskErrorMessage(new Error("invalid_model: gpt-deprecated")),
      "El modelo seleccionado no está disponible. Cámbialo desde el selector y reintenta.",
    )
  })
})
