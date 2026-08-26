import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  AGENTS_HOME_PATH,
  agentsHomeHref,
  chatSearchToAgentsHome,
  conversationIdFromLocation,
  isAgentsHomePath,
  postAuthAgentsHref,
} from "../lib/agents-home-path"

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

  it("treats /agentes as the product home and redirects /chat plus authenticated /", () => {
    const page = source("app/chat/page.tsx")
    const chatId = source("app/chat/[id]/page.tsx")
    const config = source("next.config.mjs")
    const gate = source("app/page.tsx")
    const gateSrc = source("components/agents-home-gate.tsx")
    const surface = source("app/agentes/page.tsx")
    const surfaceId = source("app/agentes/[id]/page.tsx")
    assert.match(page, /redirect\(/)
    assert.match(page, /chatSearchToAgentsHome/)
    assert.match(chatId, /agentsHomeHref/)
    assert.match(config, /source: '\/chat'/)
    assert.match(config, /destination: '\/agentes'/)
    assert.match(config, /source: '\/chat\/:id'/)
    assert.match(config, /destination: '\/agentes\/:id'/)
    assert.match(gate, /AgentsHomeGate/)
    assert.match(gateSrc, /chatSearchToAgentsHome/)
    assert.doesNotMatch(gateSrc, /ChatInterface/)
    assert.match(surface, /AgentsHomeSurface/)
    assert.match(surfaceId, /AgentsHomeSurface/)
    assert.equal(AGENTS_HOME_PATH, "/agentes")
    assert.equal(isAgentsHomePath("/agentes"), true)
    assert.equal(isAgentsHomePath("/agentes/abc"), true)
    assert.equal(isAgentsHomePath("/chat"), true)
    assert.equal(isAgentsHomePath("/"), false)
    assert.equal(isAgentsHomePath("/code"), false)
    assert.equal(chatSearchToAgentsHome("id=abc"), "/agentes?id=abc")
    assert.equal(chatSearchToAgentsHome("id=abc&computer=1", "#top"), "/agentes?id=abc&computer=1#top")
    assert.equal(chatSearchToAgentsHome(""), "/agentes")
    assert.equal(chatSearchToAgentsHome("", null, "/chat/abc"), "/agentes/abc")
    assert.equal(agentsHomeHref("id=abc"), "/agentes?id=abc")
    assert.equal(conversationIdFromLocation("/agentes/abc", ""), "abc")
    assert.equal(conversationIdFromLocation("/agentes", "id=xyz"), "xyz")
    assert.equal(postAuthAgentsHref("/"), "/agentes")
    assert.equal(postAuthAgentsHref("/chat?id=q1"), "/agentes?id=q1")
    assert.equal(postAuthAgentsHref("/code"), "/agentes")
    assert.equal(postAuthAgentsHref("/code?folder=abc"), "/agentes?folder=abc")
    assert.match(config, /source: '\/code'/)
    assert.match(config, /source: '\/code\/:path\*'/)
    assert.match(source("middleware.ts"), /pathname === '\/code' \|\| pathname\.startsWith\('\/code\/'\)/)
    assert.match(source("middleware.ts"), /NextResponse\.redirect\(url, 307\)/)
    assert.match(source("app/code/page.tsx"), /redirect\(/)
    assert.match(source("app/code/page.tsx"), /chatSearchToAgentsHome/)
    assert.doesNotMatch(source("app/code/page.tsx"), /CodeWorkspaceGate|CodeWorkspaceProvider/)
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
    assert.match(panel, /variant="overlay"/)
    assert.match(pane, /PensandoBars/)
    assert.match(pane, /Pensando…/)
    assert.match(pane, /conversationId/)
  })

  it("keeps the overlay on the same thread and does not navigate to /code", () => {
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(panel, /router\.(push|replace)\(['"`]\/code/)
    assert.doesNotMatch(panel, /href=['"`]\/code/)
    assert.doesNotMatch(panel, /window\.location.*\/code/)
    assert.match(chat, /<ChatAgentComputerPanel/)
    assert.doesNotMatch(chat.slice(chat.indexOf("openComputerPanel"), chat.indexOf("openComputerPanel") + 800), /\/code/)
    assert.match(panel, /Navegador|conversationId=\{chatId\}/)
    assert.match(source("components/code/agent-computer-shell.tsx"), /dock\.browser/)
    assert.match(source("components/code/agent-computer-shell.tsx"), /conversationId/)
  })

  it("fail-closes isolation instead of attaching another chat desktop", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const route = source("backend/src/routes/agent-computer.js")
    const key = source("backend/src/services/computer/member-key.js")
    const isolation = source("backend/src/services/computer/conversation-isolation.js")
    assert.match(pane, /sessionCache/)
    assert.match(pane, /conversationId: chatId/)
    assert.match(pane, /chat-computer-isolation-gap/)
    assert.match(pane, /if \(chatId && session.conversationBound === false\)/)
    assert.match(pane, /No se pudo aislar la computadora de esta conversación/)
    assert.match(pane, /conversationId=\$\{encodeURIComponent\(chatId\)\}/)
    assert.match(pane, /res.status === 409/)
    assert.match(pane, /emptyChat/)
    assert.match(pane, /attachUrl/)
    assert.match(panel, /variant="overlay"/)
    assert.match(route, /resolveSessionIdentity/)
    assert.match(route, /conversationBound: identity.conversationBound/)
    assert.match(route, /isolation_required/)
    assert.match(route, /sessionMatchesConversation/)
    assert.match(route, /if \(!conversationId\) return identity/)
    assert.match(route, /if \(identity.conversationBound\)/)
    assert.match(key, /conversationSessionKey/)
    assert.match(key, /conversationBound/)
    assert.match(isolation, /ISOLATION_REFUSED_ES/)
    assert.match(isolation, /sk-/)
    assert.equal(existsSync("components/chat/chat-agent-computer-panel.tsx"), true)
    assert.equal(existsSync("lib/agents-home-path.ts"), true)
    assert.equal(existsSync("app/agentes/page.tsx"), true)
  })

  it("keeps overlay chrome professional: one window, no debug copy", () => {
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const pane = source("components/code/department-computer-pane.tsx")
    const shell = source("components/code/agent-computer-shell.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    for (const [name, src] of [
      ["panel", panel],
      ["pane", pane],
      ["shell", shell],
    ] as const) {
      assert.doesNotMatch(src, /Aislamiento por chat pendiente/, `${name} must not show isolation debug banner`)
      assert.doesNotMatch(src, /session key/, `${name} must not mention session key`)
      assert.doesNotMatch(src, /noVNC/, `${name} must not mention noVNC`)
      assert.doesNotMatch(src, /XFCE/, `${name} must not mention XFCE`)
      assert.doesNotMatch(src, /Conversación pending/, `${name} must not use pending conversation copy`)
      assert.doesNotMatch(src, /no está activa en este entorno/, `${name} must not show flag-off stub`)
    }
    assert.doesNotMatch(panel, /Conversación \{chatId\}/)
    assert.doesNotMatch(panel, /<h2/)
    assert.doesNotMatch(panel, /isAgentComputerEnabled/)
    assert.match(panel, /variant="overlay"/)
    assert.match(panel, /onClose=\{onClose\}/)
    assert.match(chat, /conversationId=\{currentChat\?\.id \|\| ""\}/)
    assert.doesNotMatch(chat.slice(chat.indexOf("<ChatAgentComputerPanel"), chat.indexOf("<ChatAgentComputerPanel") + 400), /pending/)
    const openFn = chat.slice(chat.indexOf("const openComputerPanel"), chat.indexOf("const openComputerPanel") + 900)
    assert.match(openFn, /createNewChat/)
    assert.match(openFn, /skipInitialProcessing: true/)
  })
})
