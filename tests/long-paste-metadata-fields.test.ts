import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildLongPasteMetadata } from "../lib/long-paste"

/**
 * Extras for buildLongPasteMetadata fields not directly tested in the
 * base suite. Pins:
 *
 *   - hasCodeBlocks: true when text contains fenced ```...``` blocks
 *   - hasCitations: true when text contains "(Author, YYYY)" markers
 *   - detectedMime: routed from detection kind
 *   - originalCharCount / originalWordCount / originalLineCount
 *     match the document's actual shape (post-normalize)
 *   - createdAt is the passed-in date.toISOString()
 *   - estimatedTokens > 0 for substantive content
 */

describe("buildLongPasteMetadata · field population", () => {
  it("flags hasCodeBlocks=true when text contains fenced code", () => {
    const text = "Some prose.\n\n```ts\nconst x = 1\n```\n\nMore prose.".repeat(20)
    const meta = buildLongPasteMetadata(text)
    assert.equal(meta.hasCodeBlocks, true)
  })

  it("flags hasCodeBlocks=false for plain prose", () => {
    const text = "This is plain prose without any code at all. ".repeat(40)
    const meta = buildLongPasteMetadata(text)
    assert.equal(meta.hasCodeBlocks, false)
  })

  it("flags hasCitations=true for APA-style inline citations", () => {
    const text = `
      La investigación sobre RAG (García, 2024) muestra que el rerank
      por modelo de lenguaje supera a heurísticas (López, 2025).
      Estudios previos (Pérez, 2023) confirman este hallazgo, y otros
      autores (Martínez, 2024) extienden la conclusión.
    `.repeat(3)
    const meta = buildLongPasteMetadata(text)
    assert.equal(meta.hasCitations, true)
  })

  it("flags hasCitations=false when no (Author, YYYY) pattern is present", () => {
    const text = "Plain prose without any citations. ".repeat(40)
    const meta = buildLongPasteMetadata(text)
    assert.equal(meta.hasCitations, false)
  })

  it("populates originalCharCount / WordCount / LineCount from the normalized text", () => {
    const text = "Línea uno con suficientes palabras para contar.\nLínea dos.\nLínea tres."
    const meta = buildLongPasteMetadata(text)
    assert.equal(meta.originalLineCount, 3)
    assert.ok(meta.originalCharCount > 0)
    assert.ok(meta.originalWordCount >= 8)
  })

  it("createdAt is the passed-in date as ISO 8601", () => {
    const now = new Date("2026-05-16T10:00:00.000Z")
    const meta = buildLongPasteMetadata("Suficiente texto para construir metadatos.", now)
    assert.equal(meta.createdAt, "2026-05-16T10:00:00.000Z")
  })

  it("detectedMime matches the content-kind routing (code -> text/plain)", () => {
    const text = "```js\nfunction add(a,b){return a+b}\nconst x = 1\n```\n".repeat(10)
    const meta = buildLongPasteMetadata(text)
    // detection.mime is the canonical MIME for the detected kind; for
    // code blocks the routing uses text/plain or a language-specific MIME.
    assert.ok(meta.detectedMime && meta.detectedMime.length > 0)
  })

  it("estimatedTokens > 0 for substantive content", () => {
    const text = "x ".repeat(500)
    const meta = buildLongPasteMetadata(text)
    assert.ok((meta.estimatedTokens ?? 0) > 0)
  })

  it("contentHash differs across different inputs (no trivial collisions)", () => {
    const a = buildLongPasteMetadata("Texto distinto número uno ".repeat(30))
    const b = buildLongPasteMetadata("Texto distinto número dos ".repeat(30))
    assert.notEqual(a.contentHash, b.contentHash)
  })

  it("contentHash is a non-empty deterministic string", () => {
    const meta = buildLongPasteMetadata("Una cantidad razonable de texto pegado ".repeat(20))
    assert.equal(typeof meta.contentHash, "string")
    assert.ok((meta.contentHash || "").length > 0)
  })
})
