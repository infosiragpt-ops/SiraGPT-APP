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

  it("keeps negated file formats out of research DAG artifacts", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "dame 10 fuentes sobre IA sin Word",
    })

    assert.equal(analysis.intent, "web_search")
    assert.equal(analysis.contract.pipeline, "ResearchGroundingPipeline")
    assert.equal(analysis.contract.artifact_required, false)
    assert.equal(analysis.contract.multi_intent_dag.enabled, false)
    assert.deepEqual(analysis.request_intelligence.requested_formats, [])
    assert.equal(analysis.request_intelligence.excluded_formats[0].extension, ".docx")
  })

  it("routes freshness questions to web search and respects no-internet text intent", () => {
    const fresh = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "qué pasó hoy con OpenAI",
    })
    const offline = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "dame 10 fuentes sobre IA sin internet",
    })
    const offlineTextOnly = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "solo texto sin buscar en internet sobre IA",
    })

    assert.equal(fresh.intent, "web_search")
    assert.equal(fresh.contract.source_requirements.required, true)
    assert.equal(fresh.request_intelligence.context.has_freshness_lookup, true)
    assert.equal(offline.intent, "text")
    assert.equal(offline.contract.source_requirements.required, false)
    assert.equal(offline.request_intelligence.context.has_no_search_directive, true)
    assert.equal(offlineTextOnly.intent, "text")
    assert.equal(offlineTextOnly.contract.pipeline, "DirectAnswerPipeline")
    assert.deepEqual(offlineTextOnly.semantic_profile.required_tools, ["finalize"])
    assert.equal(offlineTextOnly.request_intelligence.context.has_no_search_directive, true)
    assert.equal(offlineTextOnly.request_intelligence.context.has_text_only_directive, true)
  })

  it("keeps text-only requests in chat even when artifact words appear", () => {
    const slidesAsText = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "hazme diapositivas pero solo texto en el chat",
    })
    const noFileSummary = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "no crees archivo, solo dime las ideas principales",
    })
    const negatedPpt = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "solo responde aqui, no hagas ppt, dame 5 diapositivas",
    })

    assert.equal(slidesAsText.intent, "text")
    assert.equal(slidesAsText.contract.pipeline, "DirectAnswerPipeline")
    assert.equal(slidesAsText.contract.artifact_required, false)
    assert.equal(slidesAsText.contract.required_extension, null)
    assert.equal(slidesAsText.request_intelligence.context.has_text_only_directive, true)
    assert.ok(slidesAsText.contract.forbidden_tools.includes("create_document"))
    assert.deepEqual(slidesAsText.semantic_profile.required_tools, ["finalize"])

    assert.equal(noFileSummary.intent, "text")
    assert.equal(noFileSummary.contract.pipeline, "DirectAnswerPipeline")
    assert.equal(noFileSummary.request_intelligence.context.asks_existing_document_question, false)

    assert.equal(negatedPpt.intent, "text")
    assert.equal(negatedPpt.contract.pipeline, "DirectAnswerPipeline")
    assert.equal(negatedPpt.contract.artifact_required, false)
    assert.equal(negatedPpt.contract.required_extension, null)
    assert.deepEqual(negatedPpt.semantic_profile.required_tools, ["finalize"])
    assert.ok(negatedPpt.contract.user_constraints.includes("requested_count:5 diapositivas"))
  })

  it("allows web grounding with text-only delivery but blocks file creation", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "dame fuentes actuales sobre IA solo texto",
    })
    const webNoFile = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "busca en internet noticias actuales de OpenAI pero no crees archivo",
    })

    assert.equal(analysis.intent, "web_search")
    assert.equal(analysis.contract.pipeline, "ResearchGroundingPipeline")
    assert.equal(analysis.contract.artifact_required, false)
    assert.equal(analysis.contract.source_requirements.required, true)
    assert.ok(analysis.contract.required_tools.includes("web_search"))
    assert.ok(analysis.contract.forbidden_tools.includes("create_document"))
    assert.ok(!analysis.semantic_profile.required_tools.includes("create_document"))
    assert.equal(webNoFile.intent, "web_search")
    assert.equal(webNoFile.needs_clarification, false)
    assert.equal(webNoFile.contract.ambiguity_score, 0.12)
    assert.ok(webNoFile.contract.forbidden_tools.includes("create_document"))
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

  it("routes repository setup and GitHub delivery as autonomous agent work", () => {
    const clone = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "quiero que me des este proyecto en local github.com/open-webui/open-webui",
    })
    const ship = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "mejora el backend sin tocar la interfaz, haz commit, sube a main y vigila CI verde",
    })

    assert.equal(clone.intent, "agent_task")
    assert.equal(clone.contract.pipeline, "CodePipeline")
    assert.ok(clone.semantic_profile.required_tools.includes("git.clone"))
    assert.ok(clone.semantic_profile.required_tools.includes("repo.inspect"))
    assert.equal(ship.intent, "agent_task")
    assert.ok(ship.semantic_profile.required_tools.includes("github.actions.monitor"))
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

  it("marks short contextual follow-ups as executable direct answers", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "amplía el punto 2",
      conversationHistory: [
        { role: "user", text: "dame 3 ideas de marketing" },
        { role: "assistant", text: "1. SEO local 2. Email nurturing 3. Programa de referidos" },
      ],
    })

    assert.equal(analysis.intent, "text")
    assert.equal(analysis.contract.pipeline, "DirectAnswerPipeline")
    assert.equal(analysis.request_intelligence.context.has_contextual_followup, true)
    assert.ok(analysis.contract.ambiguity_score < 0.5)
  })

  it("preserves current-thread context when a follow-up requests a presentation", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "crea una ppt con lo anterior",
      conversationHistory: [
        { role: "user", text: "dame 3 ideas de marketing" },
        { role: "assistant", text: "1. SEO local 2. Email nurturing 3. Programa de referidos" },
      ],
    })

    assert.equal(analysis.intent, "ppt")
    assert.equal(analysis.contract.pipeline, "SlidePipeline")
    assert.equal(analysis.contract.required_extension, ".pptx")
    assert.equal(analysis.request_intelligence.context.has_contextual_followup, true)
    assert.ok(analysis.contract.user_constraints.includes("conversation_context:previous_turn"))
  })

  it("exposes an observable attribution graph for intent context", () => {
    const analysis = semanticRouter.buildSemanticIntentAnalysis({
      rawUserRequest: "implementa esto con lo anterior y ejecuta tests",
      conversationHistory: [
        { role: "user", text: "Mejora el backend del software sin tocar UI" },
        { role: "assistant", text: "Listo, revisaré backend y pruebas." },
      ],
    })

    assert.equal(analysis.intent_attribution_graph.resolution.depends_on_thread, true)
    assert.equal(analysis.intent_attribution_graph.resolution.target, "software implementation")
    assert.ok(analysis.intent_attribution_graph.node_count >= 3)
    assert.ok(analysis.routing.intent_attribution_node_count >= 3)
  })
})
