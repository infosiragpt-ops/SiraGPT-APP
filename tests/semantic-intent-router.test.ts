import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const semanticRouter = require(path.join(
  process.cwd(),
  "backend/src/services/agents/semantic-intent-router.js",
))
const tokenIntelligence = require(path.join(
  process.cwd(),
  "backend/src/services/agents/request-token-intelligence.js",
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

  it("uses token windows so a negated format word does not trigger document generation", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "No quiero un Word; solo explicame que es APA 7.",
    })

    assert.equal(analysis.intent, "text")
    assert.equal(analysis.contract.artifact_required, false)
    assert.equal(analysis.contract.required_extension, null)
    assert.equal(analysis.request_intelligence.excluded_formats[0].extension, ".docx")
  })

  it("answers questions about an uploaded Word instead of generating a new Word", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "cual es la primera palabra del word?",
      files: [
        {
          id: "rdc-rsn.docx",
          name: "RDC-RSN.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    })

    assert.equal(analysis.intent, "text")
    assert.equal(analysis.contract.pipeline, "RAGDocumentUnderstandingPipeline")
    assert.equal(analysis.contract.artifact_required, false)
    assert.equal(analysis.request_intelligence.context.asks_existing_document_question, true)
    assert.ok(!analysis.semantic_profile.required_tools.includes("docx_renderer"))
  })

  it("keeps an input Excel as context while routing the requested Word as the output", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "Analiza el Excel adjunto y genera un Word con el resumen profesional.",
      files: [{ id: "datos.xlsx", name: "datos.xlsx" }],
    })

    assert.equal(analysis.intent, "doc")
    assert.equal(analysis.contract.required_extension, ".docx")
    assert.equal(analysis.contract.pipeline, "DocumentPipeline")
    assert.deepEqual(analysis.request_intelligence.requested_formats.map((f: any) => f.extension), [".docx"])
    assert.ok(analysis.semantic_profile.required_tools.includes("spreadsheet_reader"))
    assert.ok(analysis.semantic_profile.required_tools.includes("docx_renderer"))
  })

  it("builds a multi-intent DAG when the token sequence asks for research, Excel and Word", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest:
        "Busca 20 articulos reales con DOI, luego entregalos en Excel y despues redacta un Word APA 7.",
    })

    assert.equal(analysis.intent, "agent_task")
    assert.equal(analysis.contract.pipeline, "MultiIntentPipeline")
    assert.equal(analysis.contract.multi_intent_dag.enabled, true)
    assert.deepEqual(
      analysis.request_intelligence.requested_formats.map((f: any) => f.extension).sort(),
      [".docx", ".xlsx"],
    )
    assert.ok(analysis.semantic_profile.secondary_intents.includes("doi_validation"))
  })

  it("exposes deterministic token evidence for the routing layer", () => {
    const analysis = tokenIntelligence.analyzeRequestTokens({
      rawUserRequest: "crea una landing page con React y ejecuta pruebas",
    })

    assert.equal(analysis.pipeline, "CodePipeline")
    assert.equal(analysis.context.has_web_build, true)
    assert.ok(analysis.intent_scores[0].score >= analysis.intent_scores[1].score)
    assert.ok(analysis.tokens.length > 5)
  })
})
