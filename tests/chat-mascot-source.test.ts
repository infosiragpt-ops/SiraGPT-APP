import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("per-chat pixel mascots", () => {
  it("renders a seeded ChatMascot on every recent-chat row", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(sidebar, /import \{ ChatMascot \} from "@\/components\/chat-mascot"/)
    assert.match(sidebar, /data-chat-mascot="1"/)
    assert.match(sidebar, /<ChatMascot\s+seed=\{chat\.id\}/)
    assert.doesNotMatch(sidebar, /No per-chat emoji/)
  })

  it("uses the same mascot in search results for chats, not projects", () => {
    const search = source("components/ChatSearchDialog.tsx")
    assert.match(search, /import \{ ChatMascot \} from "@\/components\/chat-mascot"/)
    assert.match(search, /isProject \? \(/)
    assert.match(search, /<List className="h-4 w-4/)
    assert.match(search, /<ChatMascot\s+seed=\{chat\.id\}/)
  })

  it("shows the open conversation mascot in the /agentes header", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.match(chat, /import \{ ChatMascot \} from "@\/components\/chat-mascot"/)
    assert.match(chat, /data-testid="chat-header-mascot"/)
    assert.match(chat, /currentChat\?\.id/)
    assert.match(chat, /<ChatMascot\s+seed=\{currentChat\.id\}/)
  })
})

describe("per-chat work status dots", () => {
  it("keeps mascots and overlays B/N pulse, green done, and yellow hand waiting", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(sidebar, /data-chat-work-status=\{workStatus\}/)
    assert.match(sidebar, /resolveChatWorkStatus/)
    assert.match(sidebar, /motion-safe:animate-ping/)
    assert.match(sidebar, /bg-zinc-900/)
    assert.match(sidebar, /bg-emerald-500/)
    assert.match(sidebar, /bg-amber-400/)
    assert.match(sidebar, /<Hand className="h-3 w-3 text-amber-500"/)
    assert.doesNotMatch(sidebar, /bg-sky-500/)
    assert.doesNotMatch(sidebar, /isStreaming && "motion-safe:animate-pulse"/)
  })
})
