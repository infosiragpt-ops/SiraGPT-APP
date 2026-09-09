import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  assistantAsksUser,
  lastAssistantMessage,
  resolveChatWorkStatus,
} from "../lib/chat-work-status"

describe("chat work status", () => {
  it("treats a live stream or running task as working", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "streaming" }), "working")
    assert.equal(resolveChatWorkStatus({ activeTaskStatus: "running" }), "working")
    assert.equal(resolveChatWorkStatus({ activeTaskStatus: "queued" }), "working")
  })

  it("marks a finished stream as done unless the agent asked a question", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "done", streamContent: "Listo." }), "done")
    assert.equal(
      resolveChatWorkStatus({ streamStatus: "done", streamContent: "¿Qué color prefieres?" }),
      "needs_reply",
    )
  })

  it("uses a yellow waiting state for permission, approval, or a question", () => {
    assert.equal(
      resolveChatWorkStatus({ lastAssistant: { agentPermission: { id: "p1" } } }),
      "needs_reply",
    )
    assert.equal(
      resolveChatWorkStatus({ lastAssistant: { agentRun: { status: "waiting_approval" } } }),
      "needs_reply",
    )
    assert.equal(
      resolveChatWorkStatus({ lastAssistant: { content: "¿Me confirmas el presupuesto?" } }),
      "needs_reply",
    )
  })

  it("keeps stream errors distinct", () => {
    assert.equal(resolveChatWorkStatus({ streamStatus: "error" }), "error")
  })

  it("detects Spanish and trailing-question assistant turns", () => {
    assert.equal(assistantAsksUser("Puedes pegar el archivo?"), true)
    assert.equal(assistantAsksUser("El informe ya está listo."), false)
    assert.equal(assistantAsksUser(""), false)
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
