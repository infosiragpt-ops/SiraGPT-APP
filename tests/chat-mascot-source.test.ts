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
