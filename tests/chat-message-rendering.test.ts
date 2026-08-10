import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  isAssistantMessage,
  parseMessageFilesForRender,
  shouldRenderChatMessage,
} from "../lib/chat/message-rendering"

describe("chat message rendering", () => {
  it("accepts arrays and safely parses persisted JSON file lists", () => {
    const files = [{ id: "file-1" }]
    assert.equal(parseMessageFilesForRender(files), files)
    assert.deepEqual(parseMessageFilesForRender(JSON.stringify(files)), files)
    assert.deepEqual(parseMessageFilesForRender("not json"), [])
    assert.deepEqual(parseMessageFilesForRender('{"id":"file-1"}'), [])
  })

  it("always keeps user turns, including attachment-only and optimistic turns", () => {
    assert.equal(shouldRenderChatMessage({ role: "user", content: "" }), true)
    assert.equal(shouldRenderChatMessage({ role: "USER", files: [] }), true)
  })

  it("renders assistant turns only when they expose content, files, progress, or errors", () => {
    assert.equal(shouldRenderChatMessage({ role: "assistant", content: "" }), false)
    assert.equal(shouldRenderChatMessage({ role: "assistant", content: " listo " }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", files: '[{"id":"1"}]' }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", progressStage: "searching" }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", error: "timeout" }), true)
  })

  it("permits an empty assistant shell only for the active stream", () => {
    const assistant = { role: "Assistant", content: "" }
    assert.equal(isAssistantMessage(assistant), true)
    assert.equal(shouldRenderChatMessage(assistant), false)
    assert.equal(shouldRenderChatMessage(assistant, true), true)
    assert.equal(isAssistantMessage({ role: "user" }), false)
  })
})
