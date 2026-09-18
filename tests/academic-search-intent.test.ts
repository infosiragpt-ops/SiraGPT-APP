import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isAcademicResearchPrompt,
  shouldUseDedicatedAcademicSearch,
} from "../lib/academic-search-intent"

describe("academic search intent", () => {
  it("routes scientific discovery prompts to the federated academic search", () => {
    assert.equal(isAcademicResearchPrompt("Busca 20 artículos científicos sobre liderazgo educativo"), true)
    assert.equal(isAcademicResearchPrompt("Necesito una revisión sistemática sobre diabetes tipo 2"), true)
    assert.equal(isAcademicResearchPrompt("Encuentra el DOI de este paper en PubMed"), true)
    assert.equal(isAcademicResearchPrompt("Rastrea publicaciones en SciELO, Redalyc y OpenAlex"), true)
  })

  it("does not hijack normal chat or current-news searches", () => {
    assert.equal(isAcademicResearchPrompt("hola, ¿cómo estás?"), false)
    assert.equal(isAcademicResearchPrompt("busca las noticias de hoy en Lima"), false)
    assert.equal(isAcademicResearchPrompt("resume este texto"), false)
    assert.equal(isAcademicResearchPrompt("estudio por las noches"), false)
    assert.equal(isAcademicResearchPrompt("redacta un informe académico profesional"), false)
    assert.equal(isAcademicResearchPrompt("resume este artículo científico"), false)
  })

  it("never captures live-data or news questions, nor everyday 'fuentes/documentos/estudios' (2026-09-18 live misroute)", () => {
    assert.equal(isAcademicResearchPrompt("¿Cuál es el precio del bitcoin hoy y qué ha pasado esta semana? Dame cifras actuales con fuentes."), false)
    assert.equal(isAcademicResearchPrompt("dame las últimas noticias sobre la inflación con fuentes"), false)
    assert.equal(isAcademicResearchPrompt("muestra los documentos de la reunión de ayer"), false)
    assert.equal(isAcademicResearchPrompt("quiero fuentes sobre la inflación en Perú"), false)
    assert.equal(isAcademicResearchPrompt("necesito un estudio de mercado para mi tienda"), false)
    // academic qualifiers or academic nouns still route to the indexes
    assert.equal(isAcademicResearchPrompt("muestra estudios científicos sobre automedicación"), true)
    assert.equal(isAcademicResearchPrompt("necesito referencias bibliográficas sobre liderazgo"), true)
    assert.equal(isAcademicResearchPrompt("busca papers sobre transformers"), true)
    assert.equal(isAcademicResearchPrompt("busca artículos en arxiv sobre el precio del bitcoin hoy"), true, "an explicit index wins over the live-data veto")
  })

  it("lets a custom GPT own academic research and artifact delivery", () => {
    const prompt = "Busca artículos científicos, verifica DOI y crea Word y PDF"
    assert.equal(shouldUseDedicatedAcademicSearch(prompt), true)
    assert.equal(shouldUseDedicatedAcademicSearch(prompt, { attachmentCount: 1 }), false)
    assert.equal(shouldUseDedicatedAcademicSearch(prompt, {
      customGptId: "gpt-1",
    }), false)
    assert.equal(shouldUseDedicatedAcademicSearch(prompt, {
      customGpt: { id: "gpt-1", capabilities: { agentMode: "auto" } },
    }), false)
    assert.equal(shouldUseDedicatedAcademicSearch(prompt, {
      customGpt: { id: "gpt-1", capabilities: { agentMode: "always" } },
    }), false)
    assert.equal(shouldUseDedicatedAcademicSearch(prompt, {
      customGpt: { id: "gpt-1", capabilities: { agentMode: "off" } },
    }), false)
  })
})
