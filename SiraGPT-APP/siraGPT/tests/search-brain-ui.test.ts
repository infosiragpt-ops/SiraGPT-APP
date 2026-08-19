import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildApa, buildSynthesis, categoryActionLabel, formatYear } from "../lib/search-brain-ui"

describe("search brain UI helpers", () => {
  it("builds APA 7-style citations without exposing UI state", () => {
    const citation = buildApa({
      sourceProvider: "crossref",
      category: "academic",
      title: "Reliable RAG Evaluation",
      author: "Garcia, L.",
      datePublished: "2025-01-01T00:00:00.000Z",
      url: "https://doi.org/10.123/example",
      metadata: { doi: "10.123/example", journal: "Findings" },
    })
    assert.equal(citation, "Garcia, L. (2025). Reliable RAG Evaluation. Findings. https://doi.org/10.123/example")
  })

  it("labels category actions for typed result cards", () => {
    assert.equal(categoryActionLabel("shopping"), "Ver oferta")
    assert.equal(categoryActionLabel("jobs"), "Aplicar")
    assert.equal(categoryActionLabel("academic"), "Abrir paper")
    assert.equal(categoryActionLabel("web"), "Abrir")
  })

  it("declares heuristic synthesis when LLM rerank is unavailable", () => {
    const text = buildSynthesis("RAG", [
      { sourceProvider: "openalex", category: "academic", title: "Paper A" },
      { sourceProvider: "crossref", category: "academic", title: "Paper B" },
    ])
    assert.match(text, /Síntesis heurística auditada/)
    assert.match(text, /\[1\] Paper A/)
  })

  it("formats valid dates as years and preserves invalid labels", () => {
    assert.equal(formatYear("2026-04-27T00:00:00.000Z"), "2026")
    assert.equal(formatYear("sin fecha"), "sin fecha")
  })
})
