import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const radar = require(path.join(process.cwd(), "backend/src/services/agents/open-source-agent-radar"))
const skillsRegistry = require(path.join(process.cwd(), "backend/src/services/skills-registry"))

describe("open source agent radar", () => {
  it("builds a guarded reference-only matrix for advanced SiraGPT upgrades", () => {
    const matrix = radar.buildOpenSourceAgentRadar({ repoRoot: process.cwd() })
    const ids = new Set(matrix.references.map((project: any) => project.id))

    for (const expected of [
      "openhands-software-agent-sdk",
      "aider",
      "opencode",
      "langgraph",
      "docling",
      "librechat",
    ]) {
      assert.ok(ids.has(expected), `missing ${expected}`)
    }

    assert.equal(matrix.source_policy.mode, "reference_only")
    assert.match(matrix.source_policy.no_copy_rule, /Do not copy external repository runtime code/)
    assert.ok(matrix.counts.p0_adaptations >= 5)
    assert.ok(matrix.validation_commands.includes("git diff --check"))
    assert.ok(matrix.validation_commands.includes("bash scripts/check-secrets.sh"))
  })

  it("recommends document intelligence references for source-preserving Office work", () => {
    const matrix = radar.buildOpenSourceAgentRadar({ repoRoot: process.cwd() })
    const recs = radar.recommendOpenSourceUpgrades("editar documentos docx pdf word preservar tablas", { matrix })

    assert.ok(recs.length > 0)
    assert.equal(recs[0].project, "docling")
    assert.ok(recs[0].adaptations.some((item: any) => item.id === "source_preserving_doc_pipeline"))
    assert.match(recs[0].adaptations[0].contract, /return the edited file/)
  })

  it("recommends code-agent references for advanced multi-agent software work", () => {
    const matrix = radar.buildOpenSourceAgentRadar({ repoRoot: process.cwd() })
    const recs = radar.recommendOpenSourceUpgrades("opensource avanzado agentes multi session workspace tests", { matrix })
    const ids = new Set(recs.map((rec: any) => rec.project))

    assert.ok(ids.has("openhands-software-agent-sdk"))
    assert.ok(ids.has("opencode"))
    assert.ok(ids.has("aider") || ids.has("langgraph"))
  })

  it("renders markdown with policy, roadmap, recommendations, and validation", () => {
    const matrix = radar.buildOpenSourceAgentRadar({ repoRoot: process.cwd() })
    const recs = radar.recommendOpenSourceUpgrades("workflow rag observability", { matrix })
    const md = radar.renderOpenSourceRadarMarkdown(matrix, recs)

    assert.match(md, /# SiraGPT Open Source Agent Radar/)
    assert.match(md, /No-copy rule/)
    assert.match(md, /## Priority Roadmap/)
    assert.match(md, /## Recommendations/)
    assert.match(md, /npm run agent:opensource:map -- --json/)
  })

  it("registers the radar as an enterprise agentic skill", () => {
    const skill = skillsRegistry.getSkill("open_source_agent_radar")
    assert.ok(skill)
    assert.equal(skill.category, "agentic")
    assert.ok(skill.tags.includes("opensource"))
    assert.ok(skill.tools.includes("license_audit"))

    const recs = skillsRegistry.recommendSkills("busca proyectos opensource para mejorar software con agentes", {
      userClearance: "enterprise",
      limit: 8,
    })
    assert.ok(recs.some((candidate: any) => candidate.id === "open_source_agent_radar"))
  })
})
