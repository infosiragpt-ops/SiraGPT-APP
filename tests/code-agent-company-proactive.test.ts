import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildProactiveCompanySystemBlock,
  buildProactiveKickoffPrompt,
  departmentBootstrapTitle,
  PROACTIVE_CORE_DEPARTMENTS,
  setProactiveCompanyEnabled,
  setProactiveCompanyObjective,
} from "../lib/code-agent-company-proactive"

describe("code agent company proactive", () => {
  it("exposes core matrix-style departments including CEO Office", () => {
    const ids = PROACTIVE_CORE_DEPARTMENTS.map((department) => department.id)
    assert.ok(ids.includes("ceo-office"))
    assert.ok(ids.includes("product-engineering"))
    assert.ok(ids.includes("growth-engines"))
    assert.equal(departmentBootstrapTitle(PROACTIVE_CORE_DEPARTMENTS[0]), "CEO Office")
  })

  it("builds a kickoff prompt that demands autonomous proof-driven work", () => {
    const prompt = buildProactiveKickoffPrompt("NEXORA.COM")
    assert.match(prompt, /NEXORA\.COM/)
    assert.match(prompt, /PROACTIVO/)
    assert.match(prompt, /OKRs|departamento/i)
    assert.match(prompt, /preview/i)
  })

  it("builds a system block with departments and objective", () => {
    setProactiveCompanyEnabled(true, { workspaceId: "ws-1", objective: null })
    setProactiveCompanyObjective("Lanzar un SaaS de facturación")
    const block = buildProactiveCompanySystemBlock({
      companyName: "SiraGPT.COM",
      objective: "Lanzar un SaaS de facturación",
    })
    assert.match(block, /Modo empresa de agentes PROACTIVO/)
    assert.match(block, /Lanzar un SaaS de facturación/)
    assert.match(block, /CEO Office/)
    assert.match(block, /matrix\.build-style/)
    setProactiveCompanyEnabled(false, { workspaceId: "ws-1" })
  })

  it("preserves the start time while backend polling confirms the same run", () => {
    const first = setProactiveCompanyEnabled(true, { workspaceId: "ws-stable" })
    const second = setProactiveCompanyEnabled(true, { workspaceId: "ws-stable" })
    assert.equal(second.startedAt, first.startedAt)
    setProactiveCompanyEnabled(false, { workspaceId: "ws-stable" })
  })
})
