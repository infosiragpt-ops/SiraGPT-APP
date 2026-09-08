import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

const UI_FILES = [
  "components/agents-home-surface.tsx",
  "components/agentes/coding-ide-gate.tsx",
  "components/agentes/coding-ide-shell.tsx",
  "components/agentes/coding-terminal-pane.tsx",
  "components/agentes/coding-monaco-diff.tsx",
  "lib/agentes-coding/api.ts",
  "lib/agentes-coding/health.ts",
]

const VENDOR = /DeepSeek|OpenRouter|openrouter\.ai|model_id/

describe("AGENTES_CODING_V2 Phase 3a IDE shell", () => {
  it("gates the IDE on health.enabled and never hardcodes the flag ON", () => {
    const surface = source("components/agents-home-surface.tsx")
    const gate = source("components/agentes/coding-ide-gate.tsx")
    const health = source("lib/agentes-coding/health.ts")
    const api = source("lib/agentes-coding/api.ts")
    const page = source("app/agentes/page.tsx")

    assert.match(surface, /AgentesCodingIdeGate/)
    assert.match(page, /AgentsHomeSurface/)
    assert.doesNotMatch(page, /\/code/)
    assert.match(gate, /useAgentesCodingHealth/)
    assert.match(gate, /if \(!enabled\) return null/)
    assert.doesNotMatch(gate, /enabled\s*[:=]\s*true/)
    assert.doesNotMatch(health, /useState\(true\)/)
    assert.match(health, /useState\(false\)/)
    assert.match(api, /enabled === true/)
    assert.doesNotMatch(api, /NEXT_PUBLIC_AGENTES_CODING/)
    assert.doesNotMatch(health, /process\.env\.AGENTES_CODING_V2/)
    assert.doesNotMatch(gate, /process\.env\.AGENTES_CODING_V2/)
  })

  it("wires createSession / listFiles / readFile / writeFile and Spanish panes", () => {
    const shell = source("components/agentes/coding-ide-shell.tsx")
    const term = source("components/agentes/coding-terminal-pane.tsx")
    const api = source("lib/agentes-coding/api.ts")

    assert.match(shell, /createSession/)
    assert.match(shell, /listFiles/)
    assert.match(shell, /readFile/)
    assert.match(shell, /writeFile/)
    assert.match(shell, /Editor de código/)
    assert.match(shell, /Archivos/)
    assert.match(shell, /Diferencias/)
    assert.match(shell, /Terminal/)
    assert.match(shell, /Nueva sesión/)
    assert.match(shell, /data-testid="agentes-coding-ide"/)
    assert.match(term, /data-ws-ready="1"/)
    assert.match(term, /Ejecutar/)
    assert.match(api, /\/api\/agentes-coding|\/agentes-coding/)
    assert.doesNotMatch(shell, /app\/code|CodeWorkspaceGate|\/code\/page/)
  })

  it("never prints vendor or raw model identifiers in the coding IDE UI", () => {
    for (const file of UI_FILES) {
      assert.doesNotMatch(source(file), VENDOR, file)
    }
  })

  it("does not revive /code as a product surface", () => {
    const codePage = source("app/code/page.tsx")
    assert.match(codePage, /redirect\(/)
    assert.doesNotMatch(source("app/agentes/page.tsx"), /CodeWorkspaceGate|\/code/)
    assert.doesNotMatch(source("components/agentes/coding-ide-gate.tsx"), /app\/code/)
  })
})
