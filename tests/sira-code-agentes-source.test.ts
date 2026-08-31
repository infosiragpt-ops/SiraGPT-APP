import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

const UI_FILES = [
  "components/sira-code-agent-toggle.tsx",
  "lib/sira-code/agent-mode.ts",
  "lib/opencode/opencode-service.ts",
  "lib/opencode/use-opencode-engine.ts",
  "components/agents-home-surface.tsx",
  "app/agentes/page.tsx",
]

describe("SiraCode /agentes Phase 1", () => {
  it("keeps the native modes without exposing them in the chat permission menu", () => {
    const toggle = source("components/sira-code-agent-toggle.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    const composer = source("components/chat/ChatComposerSurface.tsx")
    const permissionMenu = source("components/chat/composer-permission-menu.tsx")
    const codePage = source("app/code/page.tsx")
    assert.match(toggle, /Construir/)
    assert.match(toggle, /Planificar/)
    assert.match(toggle, /data-testid="sira-code-agent-toggle"/)
    assert.doesNotMatch(chat, /SiraCodeAgentToggle/)
    assert.doesNotMatch(permissionMenu, /agentToggle|Modo del agente|Construir|Planificar/)
    assert.match(composer, /agentToggle/)
    assert.match(codePage, /redirect\(/)
    assert.doesNotMatch(codePage, /CodeWorkspaceGate|CodeWorkspaceProvider/)
  })

  it("never prints vendor or raw model identifiers in SiraCode UI strings", () => {
    const visible = /["'`][^"'`]*(?:DeepSeek|OpenRouter|model_id|modelId)[^"'`] *["'`]/
    for (const file of UI_FILES) {
      const text = source(file)
      assert.doesNotMatch(text, visible)
    }
    const toggle = source("components/sira-code-agent-toggle.tsx")
    assert.match(toggle, /Construir/)
    assert.match(toggle, /Planificar/)
    assert.doesNotMatch(toggle, /DeepSeek|OpenRouter|model_id/)
  })

  it("keeps /api/opencode as the public prefix and talks native SiraCode", () => {
    const svc = source("lib/opencode/opencode-service.ts")
    assert.match(svc, /\/opencode/)
    assert.match(svc, /switchAgent/)
    assert.match(svc, /return json\.result\n  \},\n\n  \/\*\* Switch/)
    assert.match(svc, /SiraCode native engine/)
    assert.doesNotMatch(svc, /OPENCODE_SERVER_URL/)
    assert.doesNotMatch(svc, /vendor\/opencode/)
  })
})
