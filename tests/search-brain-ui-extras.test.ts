import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildApa,
  buildSynthesis,
  categoryActionLabel,
  formatYear,
} from "../lib/search-brain-ui"

/**
 * Extras on top of the 4 base tests. Branch coverage for buildApa
 * fallbacks, buildSynthesis empty-states, categoryActionLabel news +
 * default branches, and a few formatYear edge cases.
 */

describe("buildApa · fallbacks", () => {
  it("uses 'Autor desconocido' when author is missing", () => {
    const citation = buildApa({
      sourceProvider: "openalex",
      category: "academic",
      title: "Paper without author",
      datePublished: "2024-06-01T00:00:00.000Z",
    })
    assert.match(citation, /Autor desconocido \(2024\)/)
  })

  it("uses 's. f.' (sin fecha) when no date or year metadata", () => {
    const citation = buildApa({
      sourceProvider: "scopus",
      category: "academic",
      title: "Paper with no date",
      author: "X, Y.",
    })
    assert.match(citation, /\(s\. f\.\)/)
  })

  it("prefers metadata.year over datePublished when both present", () => {
    const citation = buildApa({
      sourceProvider: "crossref",
      category: "academic",
      title: "Year-vs-date",
      author: "Z, A.",
      datePublished: "2020-01-01T00:00:00.000Z",
      metadata: { year: 2022 },
    })
    assert.match(citation, /\(2022\)/)
    assert.equal(citation.includes("(2020)"), false)
  })

  it("falls back to sourceProvider when no venue/journal metadata", () => {
    const citation = buildApa({
      sourceProvider: "scopus",
      category: "academic",
      title: "Title",
      author: "X.",
      datePublished: "2023-01-01T00:00:00.000Z",
    })
    assert.match(citation, /\. scopus\./)
  })

  it("uses url when no doi available", () => {
    const citation = buildApa({
      sourceProvider: "x",
      category: "news",
      title: "Article",
      author: "R.",
      url: "https://example.com/abc",
    })
    assert.ok(citation.endsWith(" https://example.com/abc"))
  })

  it("omits trailing url segment when neither doi nor url is present", () => {
    const citation = buildApa({
      sourceProvider: "x",
      category: "news",
      title: "Article",
      author: "R.",
    })
    // No trailing https:// segment.
    assert.equal(/https?:\/\//.test(citation), false)
  })
})

describe("buildSynthesis · empty states", () => {
  it("returns the placeholder when query is empty / whitespace", () => {
    assert.match(buildSynthesis("", []), /aparecerá aquí con citas numeradas/)
    assert.match(buildSynthesis("   ", []), /aparecerá aquí con citas numeradas/)
  })

  it("returns the 'no results' placeholder when query is present but results empty", () => {
    assert.match(
      buildSynthesis("RAG eval", []),
      /Sin resultados todavía/,
    )
  })

  it("switches the mode label when llmReranked=true", () => {
    const text = buildSynthesis(
      "x",
      [{ sourceProvider: "p", category: "academic", title: "T" }],
      true,
    )
    assert.match(text, /Síntesis con reranking LLM/)
    assert.equal(text.includes("Síntesis heurística"), false)
  })

  it("caps the top-results list at the first 3", () => {
    const text = buildSynthesis("x", [
      { sourceProvider: "p", category: "academic", title: "A" },
      { sourceProvider: "p", category: "academic", title: "B" },
      { sourceProvider: "p", category: "academic", title: "C" },
      { sourceProvider: "p", category: "academic", title: "D" },
    ])
    assert.match(text, /\[1\] A/)
    assert.match(text, /\[3\] C/)
    assert.equal(text.includes("[4]"), false)
    assert.equal(text.includes("D"), false)
  })
})

describe("categoryActionLabel · all branches", () => {
  it("returns 'Leer noticia' for news category", () => {
    assert.equal(categoryActionLabel("news"), "Leer noticia")
  })

  it("returns 'Abrir' for any unknown category", () => {
    assert.equal(categoryActionLabel("unknown"), "Abrir")
    assert.equal(categoryActionLabel(""), "Abrir")
  })
})

describe("formatYear · edge cases", () => {
  it("returns year for ISO date strings", () => {
    assert.equal(formatYear("2024-12-31T23:59:59.999Z"), "2024")
  })

  it("returns the input verbatim for unparseable values", () => {
    assert.equal(formatYear("not-a-date"), "not-a-date")
    assert.equal(formatYear(""), "")
  })

  it("handles year-only strings", () => {
    // "2024" parses as Jan 1 2024 UTC.
    assert.equal(formatYear("2024"), "2024")
  })
})
