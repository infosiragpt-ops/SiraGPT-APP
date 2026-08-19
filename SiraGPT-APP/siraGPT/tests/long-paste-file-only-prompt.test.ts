import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildFileOnlyPrompt } from "../lib/long-paste"

/**
 * Extras for buildFileOnlyPrompt. The base suite has 2 happy-path
 * tests; these pin the multi-doc branch + fallbacks.
 */

const meta = (overrides: Record<string, unknown> = {}) => ({
  kind: "long_paste_document" as const,
  title: "Untitled",
  text: "x".repeat(2000),
  ...overrides,
})

describe("buildFileOnlyPrompt · single-doc branch", () => {
  it("includes estimated pages when present", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ title: "Tesis", estimatedPages: 12 }) },
    ])
    assert.match(prompt, /Tesis/)
    assert.match(prompt, /~12 páginas/)
  })

  it("includes structure hint when structuralScore > 3", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ structuralScore: 5 }) },
    ])
    assert.match(prompt, /estructura jerárquica/)
  })

  it("DOES NOT include structure hint when structuralScore <= 3", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ structuralScore: 2 }) },
    ])
    assert.equal(prompt.includes("estructura jerárquica"), false)
  })

  it("uses generic 'documento de texto' for prose contentKind", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ contentKind: "prose" }) },
    ])
    assert.match(prompt, /documento de texto adjunto/)
  })

  it("uses the KIND_TO_HUMAN label for non-prose contentKind", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ contentKind: "csv", title: "data.csv" }) },
    ])
    assert.match(prompt, /dataset CSV adjunto/)
  })

  it("includes programming language hint when present", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ contentKind: "code", programmingLanguage: "python" }) },
    ])
    assert.match(prompt, /lenguaje detectado: python/)
  })
})

describe("buildFileOnlyPrompt · multi-doc branch", () => {
  it("returns a summary listing all docs by kind count", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta({ contentKind: "prose" }) },
      { longPasteMeta: meta({ contentKind: "prose" }) },
      { longPasteMeta: meta({ contentKind: "code" }) },
    ])
    assert.match(prompt, /3 archivos adjuntos/)
    // The summary pluralises "documento de texto" -> "documento de textos"
    // and includes "fragmento de código" (1 occurrence, singular).
    assert.match(prompt, /2 documento de textos/)
    assert.match(prompt, /1 fragmento de código/)
  })

  it("falls back to 'prose' when contentKind is missing", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: meta() }, // contentKind undefined
      { longPasteMeta: meta() },
    ])
    assert.match(prompt, /2 archivos adjuntos/)
    assert.match(prompt, /2 documento de textos/)
  })
})

describe("buildFileOnlyPrompt · no-long-paste fallback", () => {
  it("returns the generic prompt when no files carry long-paste metadata", () => {
    const prompt = buildFileOnlyPrompt([
      { name: "a.pdf", type: "application/pdf" },
      { name: "b.png", type: "image/png" },
    ])
    assert.equal(prompt, "Analiza los archivos adjuntos y responde según el contexto del hilo.")
  })

  it("returns the generic prompt for an empty files array", () => {
    const prompt = buildFileOnlyPrompt([])
    assert.equal(prompt, "Analiza los archivos adjuntos y responde según el contexto del hilo.")
  })

  it("returns the generic prompt when long-paste metadata is malformed", () => {
    const prompt = buildFileOnlyPrompt([
      { longPasteMeta: { kind: "not_a_long_paste" } }, // invalid kind
      { longPasteMeta: { kind: "long_paste_document" } }, // missing text/title
    ])
    assert.equal(prompt, "Analiza los archivos adjuntos y responde según el contexto del hilo.")
  })
})
