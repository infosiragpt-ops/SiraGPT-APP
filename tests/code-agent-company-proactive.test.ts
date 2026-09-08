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
  it("exposes the full matrix-style fleet including CEO Office and all departments", () => {
    const ids = PROACTIVE_CORE_DEPARTMENTS.map((department) => department.id)
    assert.ok(ids.includes("ceo-office"))
    assert.ok(ids.includes("product-engineering"))
    assert.ok(ids.includes("engineering-01"))
    assert.ok(ids.includes("engineering-02"))
    assert.ok(ids.includes("growth-engines"))
    assert.ok(ids.includes("sales"))
    assert.ok(ids.includes("customer-success"))
    assert.ok(ids.includes("marketing"))
    assert.ok(ids.includes("trust"))
    assert.ok(ids.includes("market-intelligence"))
    assert.ok(ids.includes("localization"))
    assert.ok(ids.includes("integrations"))
    assert.ok(ids.includes("website-distribution"))
    assert.ok(ids.includes("agent-infrastructure"))
    // No legacy sales-operations department id; that id is a mission only.
    assert.equal(ids.includes("sales-operations"), false)
    // Unique ids and real capacity so office seats are never 0 by default.
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(PROACTIVE_CORE_DEPARTMENTS.every((department) => (department.desiredAgents || 0) >= 1))
    assert.equal(departmentBootstrapTitle(PROACTIVE_CORE_DEPARTMENTS[0]), "CEO Office")
  })

  it("builds a kickoff prompt that demands autonomous proof-driven work", () => {
    const prompt = buildProactiveKickoffPrompt("NEXORA.COM")
    assert.match(prompt, /NEXORA\.COM/)
    assert.match(prompt, /PROACTIVO/)
    assert.match(prompt, /OKRs|departamento/i)
    assert.match(prompt, /evidencia|preview/i)
    assert.match(prompt, /Facebook.*LinkedIn.*X/)
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
    assert.match(block, /modo Revisión/i)
    assert.match(block, /límite diario/i)
    setProactiveCompanyEnabled(false, { workspaceId: "ws-1" })
  })

  it("preserves the start time while backend polling confirms the same run", () => {
    const first = setProactiveCompanyEnabled(true, { workspaceId: "ws-stable" })
    const second = setProactiveCompanyEnabled(true, { workspaceId: "ws-stable" })
    assert.equal(second.startedAt, first.startedAt)
    setProactiveCompanyEnabled(false, { workspaceId: "ws-stable" })
  })
})
