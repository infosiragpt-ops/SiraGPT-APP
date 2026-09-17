import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { hrefForCodeUrl, looksLikePlainOcrText, splitCodeWithUrls } from "../lib/chat/code-block-utils"

describe("chat code block URL helpers", () => {
  it("linkifies OCR URLs and keeps surrounding text", () => {
    const segments = splitCodeWithUrls("La URL es https://mecaelectricperu.com.pe y nada más.")
    assert.deepEqual(segments, [
      { type: "text", value: "La URL es " },
      { type: "url", value: "https://mecaelectricperu.com.pe" },
      { type: "text", value: " y nada más." },
    ])
    assert.equal(hrefForCodeUrl("https://mecaelectricperu.com.pe"), "https://mecaelectricperu.com.pe/")
    assert.equal(hrefForCodeUrl("javascript:alert(1)"), null)
  })

  it("treats short URL-only OCR fences as plain text", () => {
    assert.equal(looksLikePlainOcrText("text", "https://mecaelectricperu.com.pe"), true)
    assert.equal(looksLikePlainOcrText("javascript", "const x = 1"), false)
  })
})
