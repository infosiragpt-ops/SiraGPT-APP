import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  blobToFile,
  sanitizeHtml,
  validateFile,
  validateBatch,
} from "../lib/attachment-ingest"

/**
 * Extra coverage for attachment-ingest. The base suite already has the
 * 3 happy paths (xlsx allow, legacy xls reject, pasted blob keeps
 * uploadable). This file pins the security-shaped paths:
 *
 *   - sanitizeHtml (clipboard HTML can carry script/style/onclick).
 *   - validateFile rejection codes the composer relies on for toasts.
 *   - blobToFile naming + MIME fallback.
 *   - validateBatch count cap.
 */

describe("sanitizeHtml · script / style / event-handler strip", () => {
  it("returns '' for empty / nullish input", () => {
    assert.equal(sanitizeHtml(""), "")
    // @ts-expect-error - testing the runtime guard
    assert.equal(sanitizeHtml(null), "")
  })

  it("strips a complete <script> tag and its body", () => {
    assert.equal(
      sanitizeHtml('<p>hi</p><script>alert("x")</script><p>bye</p>'),
      "<p>hi</p><p>bye</p>",
    )
  })

  it("strips <style> tags entirely (would otherwise inject CSS)", () => {
    assert.equal(
      sanitizeHtml("<style>body{display:none}</style><p>safe</p>"),
      "<p>safe</p>",
    )
  })

  it("strips inline event handlers in all three quote styles", () => {
    assert.equal(
      sanitizeHtml('<img src="x" onerror="alert(1)" />'),
      '<img src="x" />',
    )
    assert.equal(
      sanitizeHtml("<img src='x' onclick='steal()' />"),
      "<img src='x' />",
    )
    // Unquoted handler value.
    assert.equal(sanitizeHtml("<a onclick=evil href=#>"), "<a href=#>")
  })

  it("rewrites javascript: URL hrefs / srcs to #", () => {
    assert.equal(
      sanitizeHtml('<a href="javascript:alert(1)">bad</a>'),
      '<a href="#">bad</a>',
    )
    assert.equal(
      sanitizeHtml("<a href='javascript:alert(1)'>bad</a>"),
      "<a href='#'>bad</a>",
    )
  })

  it("strips style attributes (avoids ::before content-url tricks)", () => {
    assert.equal(
      sanitizeHtml('<div style="background:url(x)">hi</div>'),
      "<div>hi</div>",
    )
  })

  it("does not strip safe attributes (alt, src, href)", () => {
    const out = sanitizeHtml('<img src="https://x/cat.png" alt="cat" />')
    assert.ok(out.includes('src="https://x/cat.png"'))
    assert.ok(out.includes('alt="cat"'))
  })
})

describe("validateFile · rejection codes", () => {
  function makeFile(name: string, type: string, size: number) {
    return new File(["x".repeat(size)], name, { type, lastModified: 1 })
  }

  it("rejects empty files with code 'empty_file'", () => {
    const f = new File([], "empty.png", { type: "image/png" })
    const v = validateFile(f)
    assert.equal(v.ok, false)
    assert.equal(v.code, "empty_file")
  })

  it("rejects disallowed MIMEs and extensions with 'type_not_allowed'", () => {
    const v = validateFile(makeFile("rogue.exe", "application/x-msdownload", 10))
    assert.equal(v.ok, false)
    assert.equal(v.code, "type_not_allowed")
    assert.match(v.reason!, /Tipo no permitido/)
  })

  it("accepts a known MIME (image/png)", () => {
    const v = validateFile(makeFile("ok.png", "image/png", 10))
    assert.equal(v.ok, true)
  })

  it("accepts a known extension even with missing MIME", () => {
    const v = validateFile(makeFile("notes.md", "", 10))
    assert.equal(v.ok, true)
  })

  it("rejects when caller opts into a size cap that's exceeded", () => {
    const v = validateFile(makeFile("big.pdf", "application/pdf", 1024 * 1024 * 8), {
      maxBytes: 1024 * 1024,
    })
    assert.equal(v.ok, false)
    assert.equal(v.code, "size_exceeded")
    assert.match(v.reason!, /1 MB/)
  })
})

describe("blobToFile", () => {
  it("uses a deterministic pasted-* name when no hint is given", () => {
    const blob = new Blob(["x"], { type: "image/png" })
    const f = blobToFile(blob)
    assert.match(f.name, /^pasted-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/)
    assert.equal(f.type, "image/png")
  })

  it("uses the explicit hint when provided", () => {
    const blob = new Blob(["x"], { type: "image/jpeg" })
    const f = blobToFile(blob, "screenshot.jpg")
    assert.equal(f.name, "screenshot.jpg")
  })

  it("falls back to .bin + octet-stream when MIME is unknown", () => {
    const blob = new Blob(["x"], { type: "" })
    const f = blobToFile(blob)
    assert.match(f.name, /\.bin$/)
    assert.equal(f.type, "application/octet-stream")
  })
})

describe("validateBatch · count cap", () => {
  function ok(name: string) {
    return new File(["x"], name, { type: "image/png" })
  }

  it("returns all files when below the cap", () => {
    const files = [ok("a.png"), ok("b.png")]
    const result = validateBatch(files)
    assert.equal(result.accepted.length, 2)
    assert.equal(result.rejected.length, 0)
  })

  it("caps the accepted list at the default maxCount and routes the rest to rejected", () => {
    // Default cap is 10 (matches backend `files: 10`).
    const files = Array.from({ length: 13 }, (_, i) => ok(`f${i}.png`))
    const result = validateBatch(files)
    assert.equal(result.accepted.length, 10)
    assert.equal(result.rejected.length, 3)
    assert.equal(result.rejected[0].code, "count_exceeded")
  })
})
