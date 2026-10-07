import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  browserUrlFromPrompt,
  DEFAULT_BROWSER_HOME,
  DEFAULT_SEARCH_URL,
  extractHttpUrlFromText,
  isComputerNavigateTool,
  looksLikeSearchQuery,
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

  it("turns a search prompt into a Google URL when no http(s) link is present", () => {
    assert.equal(browserUrlFromPrompt(""), DEFAULT_BROWSER_HOME)
    assert.equal(browserUrlFromPrompt("https://id.elsevier.com"), "https://id.elsevier.com/")
    const search = browserUrlFromPrompt("busca información sobre Scopus")
    assert.match(search, /^https:\/\/www\.google\.com\/search\?q=/)
    assert.match(search, /Scopus/)
  })

  // Production 2026-10-07: «google» in the address bar was sent as
  // https://google/ and Chromium answered ERR_NAME_NOT_RESOLVED. Words are a
  // search; the backend twin (navigate-url.js) applies the same rule.
  it("turns plain words into a search and keeps real addresses, in lockstep with the backend gate", () => {
    const word = sanitizeNavigateUrl("google")
    assert.deepEqual(word, { ok: true, url: `${DEFAULT_SEARCH_URL}google` })
    assert.deepEqual(sanitizeNavigateUrl("clima en lima"), { ok: true, url: `${DEFAULT_SEARCH_URL}clima%20en%20lima` })
    assert.equal(parseNavigateUrlFromToolArgs({ url: "wikipedia" }), `${DEFAULT_SEARCH_URL}wikipedia`)
    for (const raw of ["google", "clima en lima"]) assert.equal(looksLikeSearchQuery(raw), true, raw)
    const addresses: Array<[string, string]> = [
      ["scopus.com", "https://scopus.com/"],
      ["localhost", "https://localhost/"],
      ["localhost:3000/admin", "https://localhost:3000/admin"],
      ["intranet:8080", "https://intranet:8080/"],
      ["127.0.0.1", "https://127.0.0.1/"],
      ["http://intranet", "http://intranet/"],
      ["www.google.com/search?q=hello world", "https://www.google.com/search?q=hello%20world"],
    ]
    for (const [raw, expected] of addresses) {
      assert.equal(looksLikeSearchQuery(raw), false, raw)
      assert.deepEqual(sanitizeNavigateUrl(raw), { ok: true, url: expected }, raw)
    }
    assert.equal(sanitizeNavigateUrl("javascript:alert(1)").ok, false)
    assert.equal(sanitizeNavigateUrl("://missing-scheme").ok, false)
    assert.equal(sanitizeNavigateUrl("a".repeat(400)).ok ? (sanitizeNavigateUrl("a".repeat(400)) as { url: string }).url : "", `${DEFAULT_SEARCH_URL}${"a".repeat(180)}`)
    const backend = source("backend/src/services/computer/navigate-url.js")
    assert.match(backend, /function looksLikeSearchQuery/)
    assert.match(backend, /const DEFAULT_SEARCH_URL = 'https:\/\/www\.google\.com\/search\?q='/)
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
    // Opening the clean browser preserves the current tab instead of forcing
    // a search home page. Explicit prompts still use browserUrlFromPrompt.
    assert.doesNotMatch(chat, /url: DEFAULT_BROWSER_HOME/)
    assert.match(chat, /openComputerPanel\(\{ browser: true \}\)/)
    assert.match(chat, /setComputerNavigateUrl\(opts\?\.url \|\| ""\)/)
    assert.match(chat, /browserUrlFromPrompt/)
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
    assert.match(bar, /postComputerNavigate/)
    assert.match(bar, /sanitizeNavigateUrl/)
    assert.match(bar, /conversationId/)
    assert.match(shell, /<IntegratedBrowserBar/)
    assert.match(panel, /<IntegratedBrowserBar/)
    assert.match(panel, /startExpanded/)
    assert.match(panel, /initialDock/)
    assert.match(panel, /preferAgentComputer/)
    const client = source("lib/computer-navigate-client.ts")
    assert.match(client, /agent-computer\/sessions/)
    assert.match(client, /agent-computer\/navigate/)
    assert.doesNotMatch(client, /focus: "browser"/)
    assert.match(client, /DEFAULT_BROWSER_HOME/)
    assert.match(client, /browserUrlFromPrompt/)
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /preferAgentComputer/)
    assert.match(pane, /desk\?\.enabled && !preferAgentComputer/)
    const route = source("backend/src/routes/agent-computer.js")
    assert.match(route, /navigatePage\(session, url/)
    assert.doesNotMatch(route, /openUrlInChrome/)
    assert.doesNotMatch(route, /fallback: 'chrome',\s*detail:/)
    const tools = source("backend/src/services/computer/chat-computer-tools.js")
    assert.match(tools, /navigatePage\(session, url/)
    const livePage = source("backend/src/services/computer/live-page.js")
    assert.match(livePage, /chromium\.connectOverCDP/)
    assert.match(livePage, /page\.goto\(url/)
    assert.doesNotMatch(livePage, /chromium\.launch|browser\.newContext\(/)
    assert.match(livePage, /browser\.contexts\(\)\[0\]\.newPage\(\)/)
    assert.doesNotMatch(tools, /ok: true,\s*tool: 'computer_navigate',\s*url,\s*fallback/)
  })
})
