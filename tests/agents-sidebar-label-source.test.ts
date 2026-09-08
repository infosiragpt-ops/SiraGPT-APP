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
    assert.match(sidebar, /aria-label="Nuevo agente ⌘N"/)
    assert.doesNotMatch(sidebar, /Nuevo chat ⌘N/)
    assert.doesNotMatch(sidebar, /aria-label="Chats"/)
    assert.doesNotMatch(sidebar, />Chats</)
  })

  it("removes the Empresas mode row and clears its obsolete saved preference", () => {
    const sidebar = source("components/app-sidebar.tsx")
    assert.doesNotMatch(sidebar, /aria-label="Empresas"/)
    assert.doesNotMatch(sidebar, />Empresas</)
    assert.doesNotMatch(sidebar, /\bBriefcase\b/)
    assert.doesNotMatch(sidebar, /switchSidebarMode/)
    assert.doesNotMatch(sidebar, /localStorage\.getItem\("sira:sidebar:mode"\)/)
    assert.match(
      sidebar,
      /localStorage\.removeItem\("sira:sidebar:mode"\)/,
      "returning users must not remain in the mode whose only exit was removed",
    )
  })

  it("keeps the history back/forward arrows off the agents canvas header", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(chat, /AgentsHistoryNav/)
    assert.doesNotMatch(chat, /agents-history-nav/)
  })

  it("never prefixes chat titles with literal braces", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(
      chat,
      /title: `\{\}/,
      "agent-task chats must not create titles like «{} transcribir»",
    )
  })
})
