import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  extractChatDecisionRequest,
  extractChatDecisionRequestFromMessages,
  formatDecisionAnswers,
  lastAssistantMessage,
  resolveChatWorkStatus,
} from "../lib/chat-work-status"

describe("chat work status", () => {
  it("treats a live stream or running task as working", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "streaming" }), "working")
    assert.equal(resolveChatWorkStatus({ activeTaskStatus: "running" }), "working")
    assert.equal(resolveChatWorkStatus({ activeTaskStatus: "queued" }), "working")
  })

  it("does not raise the hand for greetings or trailing questions", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "done", streamContent: "Listo." }), "done")
    assert.equal(
      resolveChatWorkStatus({ streamStatus: "done", streamContent: "¿Qué color prefieres?" }),
      "done",
    )
    assert.equal(
      resolveChatWorkStatus({
        streamStatus: "done",
        lastAssistant: { content: "Hola Valeria, ¿en qué te ayudo hoy?" },
      }),
      "done",
    )
    assert.equal(
      resolveChatWorkStatus({
        lastAssistant: { content: "¿Me confirmas el presupuesto?" },
      }),
      "idle",
    )
  })

  it("uses a yellow waiting state only for permission, approval, or a decision panel", () => {
    assert.equal(
      resolveChatWorkStatus({ lastAssistant: { agentPermission: { id: "p1" } } }),
      "needs_reply",
    )
    assert.equal(
      resolveChatWorkStatus({ lastAssistant: { agentRun: { status: "waiting_approval" } } }),
      "needs_reply",
    )
    assert.equal(
      resolveChatWorkStatus({
        lastAssistant: {
          content: {
            text: "Necesito una aclaración para continuar.",
            clarifying_questions: ["¿Es para web o móvil?"],
          },
        },
      }),
      "needs_reply",
    )
  })

  it("keeps a pending permission visible even while the stream is still open", () => {
    assert.equal(
      resolveChatWorkStatus({
        streamStatus: "streaming",
        lastAssistant: { agentPermission: { permissionId: "p1", name: "shell" } },
      }),
      "needs_reply",
    )
  })

  it("clears a clarification wait after the user already replied", () => {
    assert.equal(
      resolveChatWorkStatus({
        lastMessageRole: "user",
        lastAssistant: {
          content: { clarifying_questions: ["¿Web o móvil?"] },
        },
      }),
      "idle",
    )
  })

  it("keeps stream errors distinct", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "error" }), "error")
  })

  it("reads the last assistant message, skipping trailing user turns", () => {
    const last = lastAssistantMessage([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿Seguimos?" },
      { role: "USER", content: "sí" },
    ])
    assert.equal(last?.content, "¿Seguimos?")
  })
})

describe("chat decision request", () => {
  it("does not treat a greeting as a decision panel", () => {
    assert.equal(
      extractChatDecisionRequest({ content: "Hola Valeria, ¿en qué te ayudo hoy?" }),
      null,
    )
    assert.equal(
      extractChatDecisionRequestFromMessages([
        { role: "user", content: "hola" },
        { role: "assistant", content: "Hola Valeria, ¿en qué te ayudo hoy?" },
      ]),
      null,
    )
  })

  it("marks Permitir ahora as the recommended permission option", () => {
    const request = extractChatDecisionRequest({
      agentPermission: { permissionId: "perm-1", name: "shell", humanDescription: "npm install" },
    })
    assert.equal(request?.kind, "permission")
    assert.equal(request?.permissionId, "perm-1")
    assert.equal(request?.questions[0]?.text.includes("shell"), true)
    assert.equal(request?.questions[0]?.options[0]?.id, "allow")
    assert.equal(request?.questions[0]?.options[0]?.recommended, true)
    assert.equal(request?.questions[0]?.options[0]?.label, "Permitir ahora")
  })

  it("uses the first clarifying answer as recommended", () => {
    const request = extractChatDecisionRequest({
      content: {
        clarifying_questions: ["¿Qué enfoque prefieres?"],
        options: ["Sitio web responsive", "App nativa"],
      },
    })
    assert.equal(request?.kind, "clarification")
    assert.equal(request?.questions[0]?.text, "¿Qué enfoque prefieres?")
    assert.equal(request?.questions[0]?.options[0]?.label, "Sitio web responsive")
    assert.equal(request?.questions[0]?.options[0]?.recommended, true)
    assert.equal(request?.allowCustomReply, true)
    assert.equal(request?.allowSkip, true)
  })

  it("keeps one card per clarifying question with its own options", () => {
    const request = extractChatDecisionRequest({
      content: {
        clarifying_questions: [
          {
            question: "Las 12 fotos incluyen 4 con niños del programa. ¿Cómo las inserto?",
            options: [
              { label: "Difuminar rostros", description: "Difumino los rostros antes de insertarlas.", recommended: true },
              { label: "Insertarlas tal cual" },
              { label: "Solo fotos sin rostro" },
            ],
          },
          {
            question: "¿Dónde las pongo en el informe?",
            options: [
              { label: "En el anexo", recommended: true },
              { label: "En el cuerpo" },
            ],
          },
        ],
      },
    })
    assert.equal(request?.questions.length, 2)
    assert.match(request?.questions[0]?.text || "", /¿Cómo las inserto/)
    assert.equal(request?.questions[0]?.options[0]?.label, "Difuminar rostros")
    assert.equal(request?.questions[0]?.options[0]?.recommended, true)
    assert.equal(request?.questions[1]?.options[0]?.label, "En el anexo")
  })

  it("joins several answers so the agent can keep working", () => {
    const text = formatDecisionAnswers(
      [
        { id: "q0", text: "¿Cómo las inserto?", options: [] },
        { id: "q1", text: "¿Dónde las pongo?", options: [] },
      ],
      {
        q0: { id: "a", label: "Difuminar rostros", replyText: "Difuminar rostros" },
        q1: { id: "b", label: "En el anexo", replyText: "En el anexo" },
      },
    )
    assert.match(text, /¿Cómo las inserto\?/)
    assert.match(text, /Difuminar rostros/)
    assert.match(text, /¿Dónde las pongo\?/)
    assert.match(text, /En el anexo/)
  })

  it("hides a clarification panel after the human already answered", () => {
    const request = extractChatDecisionRequestFromMessages([
      { role: "assistant", content: { clarifying_questions: ["¿Web o móvil?"] } },
      { role: "user", content: "web" },
    ])
    assert.equal(request, null)
  })
})
