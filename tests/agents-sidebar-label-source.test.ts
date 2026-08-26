import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("agentes sidebar chrome", () => {
  it("uses the Claude-style header strip instead of the mode tablist", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.doesNotMatch(sidebar, /Modo de la barra lateral/)
    assert.doesNotMatch(sidebar, /role="tablist"/)
    assert.match(sidebar, /aria-label="Atrás"/)
    assert.match(sidebar, /aria-label="Adelante"/)
    assert.match(sidebar, /aria-label="Nuevo chat ⌘N"/)
    assert.doesNotMatch(sidebar, /aria-label="Chats"/)
    assert.doesNotMatch(sidebar, />Chats</)
  })

  it("keeps Empresas reachable as a nav-row mode toggle in both modes", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(
      sidebar,
      /aria-label="Empresas"[\s\S]{0,260}switchSidebarMode\(sidebarMode === "code" \? "chat" : "code"\)/,
      "the Empresas row must toggle the sidebar mode",
    )
    assert.match(sidebar, /aria-pressed=\{sidebarMode === "code"\}/)
  })

  it("keeps the history back/forward arrows off the agents canvas header", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(chat, /AgentsHistoryNav/)
    assert.doesNotMatch(chat, /agents-history-nav/)
  })
})
