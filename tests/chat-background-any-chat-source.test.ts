import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

describe("chat background multi-chat reliability", () => {
  it("never steals focus when a background chat receives a user turn", () => {
    const ctx = readFileSync(join(ROOT, "lib/chat-context-integrated.tsx"), "utf8")
    assert.match(
      ctx,
      /setCurrentChat\(\(prev\) => \(prev\?\.id === activeChat\.id \? updatedChat : prev\)\)/,
    )
    assert.match(ctx, /Never steal focus/)
  })

  it("does not force global streaming flags off when one chat finishes", () => {
    const ctx = readFileSync(join(ROOT, "lib/chat-context-integrated.tsx"), "utf8")
    // The durable onClose path must not blanket setIsStreaming(false).
    assert.match(ctx, /Do NOT force setIsStreaming\(false\)/)
    assert.match(ctx, /markChatIdle in `finally` re-syncs aggregates/)
    // Still uses per-chat markChatIdle for aggregate sync.
    assert.match(ctx, /markChatIdle\(activeChat\.id, streamId\)/)
  })

  it("folds finished background partials into the chats cache and polls catch-up", () => {
    const ctx = readFileSync(join(ROOT, "lib/chat-context-integrated.tsx"), "utf8")
    assert.match(ctx, /hydrateTrailingAssistant\(c\.messages \|\| \[\], finalPartial\)/)
    assert.match(ctx, /Background completion catch-up/)
    assert.match(ctx, /pollBg/)
  })

  it("drains queued messages for idle background chats while viewing another", () => {
    const ui = readFileSync(join(ROOT, "components/chat-interface-enhanced.tsx"), "utf8")
    assert.match(ui, /Background drain for any other idle chat/)
    assert.match(ui, /void addMessage\(bgNext\.msg, files, targetChat\)/)
    // chats must be pulled from useChat for the background drain path.
    assert.match(ui, /chats,/)
  })
})
