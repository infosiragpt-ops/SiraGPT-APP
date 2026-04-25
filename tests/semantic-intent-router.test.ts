import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const semanticRouter = require(path.join(
  process.cwd(),
  "backend/src/services/agents/semantic-intent-router.js",
))

describe("semantic intent router · structured profile", () => {
  it("builds a rich semantic profile for academic DOCX work", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest:
        "Crear un documento Word académico profesional basado en Excel y fuentes reales con citas APA 7 y DOI verificados",
      files: [{ name: "datos.xlsx" }],
    })

    assert.equal(analysis.semantic_profile.output_format, "docx")
    assert.equal(analysis.semantic_profile.language, "es")
    assert.equal(analysis.semantic_profile.quality_level, "professional_academic")
    assert.equal(analysis.semantic_profile.needs_clarification, false)
    assert.ok(analysis.semantic_profile.confidence >= 0.8)
    assert.ok(analysis.semantic_profile.secondary_intents.includes("web_research"))
    assert.ok(analysis.semantic_profile.secondary_intents.includes("apa7_citation"))
    assert.ok(analysis.semantic_profile.secondary_intents.includes("docx_export"))
    assert.ok(analysis.semantic_profile.required_tools.includes("spreadsheet_reader"))
    assert.ok(analysis.semantic_profile.required_tools.includes("web_search"))
    assert.ok(analysis.semantic_profile.required_tools.includes("doi_validator"))
    assert.ok(analysis.semantic_profile.required_tools.includes("citation_generator"))
    assert.ok(analysis.semantic_profile.required_tools.includes("docx_renderer"))
  })

  it("also creates a profile for simple chat requests", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "Hola, explícamelo en una frase",
    })

    assert.equal(analysis.semantic_profile.output_format, "chat")
    assert.equal(analysis.semantic_profile.needs_clarification, false)
    assert.ok(analysis.semantic_profile.primary_intent)
    assert.ok(Array.isArray(analysis.semantic_profile.required_tools))
  })
})
