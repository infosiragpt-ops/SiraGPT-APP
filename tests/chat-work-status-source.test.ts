import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("per-chat work status dots", () => {
  it("does not render pixel mascots on chat rows, search, or the header", () => {
    const sidebar = source("components/app-sidebar.tsx")
    const search = source("components/ChatSearchDialog.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(sidebar, /ChatMascot/)
    assert.doesNotMatch(sidebar, /data-chat-mascot/)
    assert.doesNotMatch(search, /ChatMascot/)
    assert.doesNotMatch(chat, /ChatMascot/)
    assert.doesNotMatch(chat, /chat-header-mascot/)
  })

  it("shows only B/N pulse, green done, and yellow hand waiting on the sidebar", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(sidebar, /data-chat-work-status=\{workStatus\}/)
    assert.match(sidebar, /workStatus !== "idle"/)
    assert.match(sidebar, /resolveChatWorkStatus/)
    assert.match(sidebar, /motion-safe:animate-ping/)
    assert.match(sidebar, /bg-zinc-900/)
    assert.match(sidebar, /bg-emerald-500/)
    assert.match(sidebar, /bg-amber-400/)
    assert.match(sidebar, /<Hand className="h-3\.5 w-3\.5 text-amber-500"/)
    assert.doesNotMatch(sidebar, /bg-sky-500/)
  })

  it("keeps the search dialog on the list glyph for chats, not a mascot", () => {
    const search = source("components/ChatSearchDialog.tsx")
    assert.match(search, /<MessageCircle className="h-4 w-4/)
    assert.match(search, /<List className="h-4 w-4/)
  })
})
