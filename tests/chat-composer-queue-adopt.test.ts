import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  adoptUnboundComposerQueueItems,
  createPersistedComposerQueueItem,
  isUnboundComposerQueueChatId,
} from "../lib/chat/composer-queue"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

describe("composer queue new-chat adoption", () => {
  it("treats missing and temp chat ids as unbound", () => {
    assert.equal(isUnboundComposerQueueChatId(null), true)
    assert.equal(isUnboundComposerQueueChatId("temp-chat-1"), true)
    assert.equal(isUnboundComposerQueueChatId("clxyzreal"), false)
  })

  it("rewrites parked new-chat items onto the real chat id", () => {
    const parked = createPersistedComposerQueueItem({
      id: "queued-1",
      ownerId: "user-1",
      chatId: null,
      msg: "segunda pregunta",
      files: [{ id: "file-1", name: "deck.pptx" }],
      idempotencyKey: "key-1",
    })
    const adopted = adoptUnboundComposerQueueItems([parked], "chat-real", null)
    assert.equal(adopted.changed, true)
    assert.equal(adopted.items[0].chatId, "chat-real")
  })

  it("parks a second send instead of silently returning while the chat latch is held", () => {
    const latchIndex = source.indexOf("const sendLatchKey = currentChat?.id ?? '__new__';")
    assert.notEqual(latchIndex, -1)
    const afterLatch = source.slice(latchIndex, latchIndex + 220)
    assert.doesNotMatch(
      afterLatch,
      /if \(sendInFlightChatsRef\.current\.has\(sendLatchKey\)\) return;/,
      "a second prompt must reach the busy-queue park, not no-op",
    )
    assert.match(source, /adoptUnboundComposerQueueItems\(/)
    assert.match(
      source,
      /sendInFlightChatsRef\.current\.has\(sendLatchKey\)/,
      "the per-chat latch must still park later messages",
    )
  })
})
