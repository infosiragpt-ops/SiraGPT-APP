import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizePastedText } from "../lib/long-paste"

/**
 * normalizePastedText is the common preprocessing layer used by every
 * long-paste detector. It must:
 *
 *   1. Convert Windows / Mac line endings to Unix (\r\n, \r -> \n)
 *   2. Replace non-breaking space (U+00A0) with a regular space so
 *      word + line counters see them as ordinary whitespace
 *   3. Trim leading + trailing whitespace
 *   4. Tolerate nullish inputs without throwing
 */

describe("normalizePastedText", () => {
  it("returns '' for nullish / non-string input", () => {
    // @ts-expect-error - exercising the runtime guard
    assert.equal(normalizePastedText(null), "")
    // @ts-expect-error - exercising the runtime guard
    assert.equal(normalizePastedText(undefined), "")
    assert.equal(normalizePastedText(""), "")
  })

  it("converts \\r\\n (Windows) to \\n", () => {
    assert.equal(normalizePastedText("a\r\nb\r\nc"), "a\nb\nc")
  })

  it("converts lone \\r (legacy Mac) to \\n", () => {
    assert.equal(normalizePastedText("a\rb\rc"), "a\nb\nc")
  })

  it("converts mixed \\r\\n + \\r without producing double newlines", () => {
    assert.equal(normalizePastedText("a\r\nb\rc"), "a\nb\nc")
  })

  it("replaces U+00A0 (non-breaking space) with regular space", () => {
    const nbsp = String.fromCharCode(0xa0)
    assert.equal(normalizePastedText(`hola${nbsp}mundo`), "hola mundo")
  })

  it("trims leading and trailing whitespace", () => {
    assert.equal(normalizePastedText("   abc   "), "abc")
  })

  it("trims leading and trailing newlines", () => {
    assert.equal(normalizePastedText("\n\nabc\n\n"), "abc")
  })

  it("preserves internal whitespace (only edges are trimmed)", () => {
    assert.equal(normalizePastedText("  a  b  "), "a  b")
  })

  it("composes: U+00A0 -> space then trim works at edges", () => {
    const nbsp = String.fromCharCode(0xa0)
    // Edge nbsp first becomes a regular space, then trim removes it.
    assert.equal(normalizePastedText(`${nbsp}abc${nbsp}`), "abc")
  })

  it("non-string input is coerced via String()", () => {
    // @ts-expect-error - exercising the runtime guard
    assert.equal(normalizePastedText(42), "42")
  })
})
