import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isAcademicResearchPrompt } from "../lib/academic-search-intent"

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
})
