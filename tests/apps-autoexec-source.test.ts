import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

describe("APPS autonomous full-stack wiring", () => {
  it("enables autoExecute on APPS plan + build so agents can work for hours", () => {
    const panel = readFileSync(join(ROOT, "components/codex/codex-agent-panel.tsx"), "utf8")
    const api = readFileSync(join(ROOT, "lib/codex/codex-api.ts"), "utf8")
    const chat = readFileSync(join(ROOT, "components/code/ai-code-chat-panel.tsx"), "utf8")

    assert.match(panel, /autoExecute: surface === "apps"/)
    assert.match(panel, /COMPILA TODAS LAS CAPAS/)
    assert.match(panel, /CORRIDA LARGA AUTONOMA/)
    assert.match(panel, /EXPANSION DESDE INSTRUCCION SIMPLE/)
    assert.match(api, /opts\?\.autoExecute/)
    assert.match(api, /autoExecute: true/)
    assert.equal(
      chat.match(/autoExecute:\s*true/g)?.length,
      2,
      "plan and approved build must both remain autonomous",
    )

    const contract = readFileSync(join(ROOT, "lib/code-agent/apps-mode-contract.ts"), "utf8")
    assert.match(contract, /COMPILA TODAS LAS CAPAS/)
    assert.match(contract, /EXPANSIÓN DESDE INSTRUCCIÓN SIMPLE/)
    assert.match(contract, /hasta 4 horas y 120 pasos/)
  })

  it("renames user-facing company labels to Empresas", () => {
    const es = readFileSync(join(ROOT, "messages/es.json"), "utf8")
    const page = readFileSync(join(ROOT, "app/projects/[id]/page.tsx"), "utf8")
    const sources = readFileSync(join(ROOT, "components/sources-panel.tsx"), "utf8")

    assert.match(es, /"projects": "Empresas"/)
    assert.match(es, /"title": "Empresas"/)
    assert.match(page, /Empresa movida a Papelera por 30 días\./)
    assert.match(sources, /project: "Empresa"/)
  })
})
