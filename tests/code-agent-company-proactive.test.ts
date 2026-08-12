import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  buildProactiveCompanySystemBlock,
  buildProactiveKickoffPrompt,
  departmentBootstrapTitle,
  PROACTIVE_CORE_DEPARTMENTS,
  setProactiveCompanyEnabled,
  setProactiveCompanyObjective,
} from "../lib/code-agent-company-proactive"

const companyPanelSource = readFileSync("components/code/agent-company-panel.tsx", "utf8")

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

  it("does not re-enter the department bootstrap after the durable fleet is ready", () => {
    assert.match(companyPanelSource, /const departmentSessionsReady = React\.useMemo/)
    assert.match(companyPanelSource, /departmentSessionBootstrapRef\.current\.inFlight/)
    assert.match(
      companyPanelSource,
      /return departmentSessionBootstrapRef\.current\.rootSessionId/,
    )
    assert.match(
      companyPanelSource,
      /if \(!proactiveOn \|\| departmentSessionsReady\) return\s+ensureDepartmentSessions\(\)/,
    )
    assert.match(companyPanelSource, /codeChatSessionMatchesDepartment\(existingSession, identity\)/)
  })

  it("uses authoritative project-wide cancellation and reports partial status honestly", () => {
    const start = companyPanelSource.indexOf("const cancelCompanyExecution = React.useCallback")
    const end = companyPanelSource.indexOf("const sessionForRun = React.useCallback", start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    const cancellation = companyPanelSource.slice(start, end)

    assert.match(cancellation, /await codexApi\.cancelActiveRuns\(runtimeProjectId\)/)
    assert.match(cancellation, /cancellation\?\.complete === true/)
    assert.match(cancellation, /cancellation\?\.failedRunIds\.length/)
    assert.match(cancellation, /await codexApi\.listRuns\(runtimeProjectId\)/)
    assert.match(cancellation, /toast\.warning\(/)
    assert.match(cancellation, /Cancelación parcial:/)
    assert.doesNotMatch(cancellation, /codexApi\.cancelRun\(activeRun\.id\)/)
    assert.doesNotMatch(cancellation, /cancelActiveCodexRunFamilies/)
  })

  it("reports a partial swarm resume honestly and exposes an explicit recovery retry", () => {
    const start = companyPanelSource.indexOf("const startEnterpriseExecution = React.useCallback")
    const end = companyPanelSource.indexOf("const pauseEnterpriseExecution = React.useCallback", start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    const resume = companyPanelSource.slice(start, end)

    assert.match(resume, /const resume = await codexApi\.resumeSwarm\(projectId, swarmId\)/)
    assert.match(resume, /await refreshCommandCenter\(projectId\)/)
    assert.match(resume, /if \(!resume\.complete\)/)
    assert.match(resume, /resume\.runRecovery\.failed/)
    assert.match(resume, /toast\.warning\(/)
    assert.match(resume, /Reanudación parcial:/)
    assert.match(resume, /label: "Reintentar recuperación"/)
    assert.match(resume, /void resumePersistedSwarm\(\)/)

    const partialGuard = resume.indexOf("if (!resume.complete)")
    const successToast = resume.indexOf("toast.success", partialGuard)
    assert.ok(partialGuard >= 0 && successToast > partialGuard)
  })

  it("shares accessible per-run controls across full and compact surfaces", () => {
    assert.match(companyPanelSource, /function CompanyRunActions\(/)
    assert.match(companyPanelSource, /data-testid=\{`company-run-actions-\$\{run\.id\}`\}/)
    assert.match(companyPanelSource, /layout="surface"/)
    assert.match(companyPanelSource, /layout="compact"/)
    assert.match(companyPanelSource, /aria-label=\{`Inspeccionar \$\{title\}`\}/)
    assert.match(companyPanelSource, /aria-label=\{`Detener \$\{title\}`\}/)
    assert.match(companyPanelSource, /aria-label=\{`Reintentar \$\{title\}`\}/)
  })
})
