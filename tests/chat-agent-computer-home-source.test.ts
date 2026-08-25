import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import { chatSearchToAgentsHome, isAgentsHomePath } from "../lib/agents-home-path"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")
const bootEs = "Arranca" + "ndo"
const runEs = "Ejecu" + "tar"

describe("chat agent computer home", () => {
  it("places the computer button immediately beside share", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const buttonIdx = chat.indexOf('data-testid="chat-computer-button"')
    const shareIdx = chat.indexOf('title="Compartir conversación completa"')
    assert.ok(buttonIdx > 0, "missing chat-computer-button")
    assert.ok(shareIdx > buttonIdx, "computer button must sit before share")
    assert.ok(shareIdx - buttonIdx < 1200, "computer button must be immediately beside share")
    assert.match(chat, /title="Computadora"/)
    assert.match(chat, /aria-label="Computadora"/)
    assert.match(chat, /<Monitor className="h-5 w-5" \/>/)
    assert.match(chat, /<ChatAgentComputerPanel/)
  })

  it("redirects /chat to / while preserving query and hash", () => {
    const page = source("app/chat/page.tsx")
    const config = source("next.config.mjs")
    const gate = source("app/page.tsx")
    assert.match(page, /redirect\(/)
    assert.match(page, /chatSearchToAgentsHome/)
    assert.match(config, /source: '\/chat'/)
    assert.match(config, /destination: '\/'/)
    assert.match(gate, /AgentsHomeGate/)
    assert.equal(isAgentsHomePath("/chat"), true)
    assert.equal(isAgentsHomePath("/"), true)
    assert.equal(isAgentsHomePath("/code"), false)
    assert.equal(chatSearchToAgentsHome("id=abc"), "/?id=abc")
    assert.equal(chatSearchToAgentsHome("id=abc&computer=1", "#top"), "/?id=abc&computer=1#top")
    assert.equal(chatSearchToAgentsHome(""), "/")
  })

  it("never shows Arrancando or Ejecutar in the new chat computer chrome", () => {
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const pane = source("components/code/department-computer-pane.tsx")
    const shell = source("components/code/agent-computer-shell.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    const buttonIdx = chat.indexOf('data-testid="chat-computer-button"')
    const chromeSnippet = chat.slice(Math.max(0, buttonIdx - 400), buttonIdx + 900)
    for (const [name, src] of [
      ["panel", panel],
      ["pane", pane],
      ["shell", shell],
      ["chat-computer-button", chromeSnippet],
    ] as const) {
      assert.doesNotMatch(src, new RegExp(bootEs, "i"), `${name} must not contain ${bootEs}`)
      assert.doesNotMatch(src, new RegExp(runEs, "i"), `${name} must not contain ${runEs}`)
    }
    assert.match(panel, /AgentComputerShell/)
    assert.match(panel, /DepartmentComputerPane/)
    assert.match(panel, /conversationId=\{chatId\}/)
    assert.match(pane, /PensandoBars/)
    assert.match(pane, /Pensando…/)
    assert.match(pane, /conversationId/)
  })

  it("ships the overlay file and binds sessions per conversation", () => {
    assert.equal(existsSync("components/chat/chat-agent-computer-panel.tsx"), true)
    assert.equal(existsSync("lib/agents-home-path.ts"), true)
    const pane = source("components/code/department-computer-pane.tsx")
    const route = source("backend/src/routes/agent-computer.js")
    const key = source("backend/src/services/computer/member-key.js")
    assert.match(pane, /sessionCache/)
    assert.match(pane, /conversationId: chatId/)
    assert.match(pane, /chat-computer-isolation-gap/)
    assert.match(route, /resolveSessionIdentity/)
    assert.match(route, /conversationBound/)
    assert.match(key, /conversationSessionKey/)
    assert.match(key, /conversationBound/)
  })
})
