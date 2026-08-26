import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("agentes sidebar chrome", () => {
  it("labels the sidebar mode tab as Agentes instead of Chats", () => {
    const sidebar = source("components/app-sidebar.tsx")
    const headerStart = sidebar.indexOf('aria-label="Modo de la barra lateral"')
    assert.ok(headerStart > 0, "missing sidebar mode tablist")
    const header = sidebar.slice(headerStart, headerStart + 2200)
    assert.match(header, /aria-label="Agentes"/)
    assert.match(header, />Agentes</)
    assert.doesNotMatch(header, /aria-label="Chats"/)
    assert.doesNotMatch(header, />Chats</)
    assert.match(header, /aria-label="Empresas"/)
    assert.match(header, />Empresas</)
  })

  it("keeps the history back/forward arrows off the agents canvas header", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(chat, /AgentsHistoryNav/)
    assert.doesNotMatch(chat, /agents-history-nav/)
  })
})
