import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  extractHttpUrlFromText,
  isComputerNavigateTool,
  parseNavigateUrlFromToolArgs,
  sanitizeNavigateUrl,
} from "../lib/computer-navigate"

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("client navigator URL gate", () => {
  it("upgrades a host to https and rejects script schemes", () => {
    const host = sanitizeNavigateUrl("scopus.com")
    assert.equal(host.ok, true)
    assert.equal(host.ok ? host.url : "", "https://scopus.com/")
    assert.equal(sanitizeNavigateUrl("javascript:alert(1)").ok, false)
    assert.equal(sanitizeNavigateUrl("data:text/html,x").ok, false)
    assert.equal(sanitizeNavigateUrl("").ok, false)
  })

  it("parses computer_navigate tool args and URLs pasted in chat", () => {
    assert.equal(isComputerNavigateTool("computer_navigate"), true)
    assert.equal(isComputerNavigateTool("web_search"), false)
    assert.equal(parseNavigateUrlFromToolArgs('{"url":"https://id.elsevier.com"}'), "https://id.elsevier.com/")
    assert.equal(parseNavigateUrlFromToolArgs({ href: "scopus.com" }), "https://scopus.com/")
    assert.equal(parseNavigateUrlFromToolArgs("javascript:alert(1)"), null)
    assert.equal(
      extractHttpUrlFromText("busca información en https://id.elsevier.com/as/authorization.oauth2"),
      "https://id.elsevier.com/as/authorization.oauth2",
    )
  })

  it("covers 1000 https search URLs the address bar can submit", () => {
    for (let i = 0; i < 1000; i += 1) {
      const raw = `https://nav-${i}.example.test/q/${i}`
      const result = sanitizeNavigateUrl(raw)
      assert.equal(result.ok, true, raw)
      if (result.ok) assert.equal(result.url, new URL(raw).toString())
    }
  })
})

describe("integrated browser chrome source contract", () => {
  it("places the globe navigator immediately beside the computer", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const computerIdx = chat.indexOf('data-testid="chat-computer-button"')
    const browserIdx = chat.indexOf('data-testid="chat-browser-button"')
    const shareIdx = chat.indexOf('title="Compartir conversación completa"')
    assert.ok(computerIdx > 0, "missing computer button")
    assert.ok(browserIdx > computerIdx, "globe must sit after the computer")
    assert.ok(shareIdx > browserIdx, "share stays after the navigator")
    assert.ok(browserIdx - computerIdx < 900, "globe must sit immediately beside the computer")
    assert.match(chat, /title="Navegador"/)
    assert.match(chat, /aria-label="Navegador"/)
    assert.match(chat, /openComputerPanel\(\{ browser: true/)
    assert.match(chat, /params\.get\("browser"\)/)
    assert.match(chat, /COMPUTER_NAVIGATE_WINDOW_EVENT/)
    assert.match(source("lib/chat-context-integrated.tsx"), /emitComputerNavigate/)
    assert.match(source("backend/src/services/computer/chat-computer-tools.js"), /sanitizeNavigateUrl/)
    assert.match(chat, /startExpanded=\{computerBrowserMode/)
    assert.match(chat, /initialDock=\{computerBrowserMode \? "browser" : "desktop"\}/)
  })

  it("ships a reusable address bar that posts /agent-computer/navigate", () => {
    const bar = source("components/chat/integrated-browser-bar.tsx")
    const shell = source("components/code/agent-computer-shell.tsx")
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    assert.match(bar, /data-testid="integrated-browser-bar"/)
    assert.match(bar, /data-testid="integrated-browser-url"/)
    assert.match(bar, /\/agent-computer\/navigate/)
    assert.match(bar, /sanitizeNavigateUrl/)
    assert.match(bar, /conversationId/)
    assert.match(shell, /<IntegratedBrowserBar/)
    assert.match(panel, /<IntegratedBrowserBar/)
    assert.match(panel, /startExpanded/)
    assert.match(panel, /initialDock/)
  })
})
