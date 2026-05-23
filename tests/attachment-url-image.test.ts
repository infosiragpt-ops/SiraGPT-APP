import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveImageAttachmentUrl } from "../lib/attachment-url"

/**
 * Extras for resolveImageAttachmentUrl. The base suite (10 tests)
 * already covers the common upload-to-frontend-host rewrite + base64
 * tail. These pin the priority among `imageUrl` / `url` / `base64`,
 * the `.path` fallback for filesystem-stored attachments, and the
 * mimeType fallback chain for base64 payloads.
 */

describe("resolveImageAttachmentUrl · field priority", () => {
  it("prefers imageUrl over url and base64", () => {
    const out = resolveImageAttachmentUrl(
      {
        imageUrl: "https://primary.example.com/a.png",
        url: "https://fallback.example.com/b.png",
        base64: "AAAA",
      },
      "http://localhost:5000",
    )
    assert.equal(out, "https://primary.example.com/a.png")
  })

  it("prefers url over base64 when imageUrl is missing", () => {
    const out = resolveImageAttachmentUrl(
      { url: "https://example.com/x.png", base64: "AAAA" },
      "http://localhost:5000",
    )
    assert.equal(out, "https://example.com/x.png")
  })

  it("uses local preview blobs before server URLs for optimistic chat rendering", () => {
    const out = resolveImageAttachmentUrl(
      {
        preview: "blob:http://localhost:3000/local-preview",
        url: "/uploads/user-1/photo.png",
        mimeType: "image/png",
      },
      "http://localhost:5000",
    )
    assert.equal(out, "blob:http://localhost:3000/local-preview")
  })

  it("uses base64 as last resort when only base64 is present", () => {
    // Need >= 120 chars and base64 alphabet for the heuristic.
    const big = "A".repeat(160)
    const out = resolveImageAttachmentUrl(
      { base64: big, mimeType: "image/png" },
      "http://localhost:5000",
    )
    assert.equal(out, `data:image/png;base64,${big}`)
  })
})

describe("resolveImageAttachmentUrl · base64 mimeType chain", () => {
  it("falls back to file.type when mimeType is missing", () => {
    const big = "B".repeat(160)
    const out = resolveImageAttachmentUrl(
      { base64: big, type: "image/webp" },
      "http://localhost:5000",
    )
    assert.match(out, /^data:image\/webp;base64,/)
  })

  it("falls back to image/jpeg when both mimeType and type are missing", () => {
    const big = "C".repeat(160)
    const out = resolveImageAttachmentUrl(
      { base64: big },
      "http://localhost:5000",
    )
    assert.match(out, /^data:image\/jpeg;base64,/)
  })

  it("strips whitespace from base64 before embedding into the data URL", () => {
    // A short base64 string with embedded whitespace + the helper
    // requires >= 120 chars to qualify as base64.
    const big = "D".repeat(80) + "\n   " + "E".repeat(80)
    const out = resolveImageAttachmentUrl(
      { base64: big },
      "http://localhost:5000",
    )
    // The output should not contain any whitespace inside the data URL.
    assert.equal(out.includes(" "), false)
    assert.equal(out.includes("\n"), false)
  })
})

describe("resolveImageAttachmentUrl · path fallback", () => {
  it("uses .path when imageUrl/url/base64 are all empty", () => {
    const out = resolveImageAttachmentUrl(
      { path: "/srv/uploads/user-1/photo.png" },
      "http://localhost:5000",
    )
    assert.equal(out, "http://localhost:5000/uploads/user-1/photo.png")
  })

  it("normalises Windows backslashes inside .path", () => {
    const out = resolveImageAttachmentUrl(
      { path: "C:\\srv\\uploads\\u\\x.png" },
      "http://localhost:5000",
    )
    assert.equal(out, "http://localhost:5000/uploads/u/x.png")
  })

  it("returns '' when .path is set but doesn't contain 'uploads/'", () => {
    const out = resolveImageAttachmentUrl(
      { path: "/var/tmp/random.png" },
      "http://localhost:5000",
    )
    assert.equal(out, "")
  })

  it("returns '' for a fully empty file object", () => {
    assert.equal(resolveImageAttachmentUrl({}), "")
    assert.equal(resolveImageAttachmentUrl(null), "")
    assert.equal(resolveImageAttachmentUrl(undefined), "")
  })
})
