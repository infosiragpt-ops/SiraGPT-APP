import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isImageOnlyMessageForRender } from "../lib/message-render-policy"

/**
 * Extras on top of message-render-policy.test.ts. The base suite has
 * the three core paths; this fills in:
 *
 *   - Assistant URL detection (the three CDN markers + non-match)
 *   - Image attachment recognition by both mimeType and extension
 *   - Defensive input handling (non-array parsedFiles, missing fields)
 */

describe("isImageOnlyMessageForRender · assistant image URL", () => {
  it("recognises oaidalleapiprodscus URLs", () => {
    const message = {
      role: "ASSISTANT",
      content: "https://oaidalleapiprodscus.blob.core.windows.net/x.png",
    }
    assert.equal(isImageOnlyMessageForRender(message, []), true)
  })

  it("recognises dalle CDN URLs", () => {
    const message = { role: "ASSISTANT", content: "https://cdn.dalle.openai.com/img.png" }
    assert.equal(isImageOnlyMessageForRender(message, []), true)
  })

  it("recognises /api/images/ URLs", () => {
    const message = { role: "ASSISTANT", content: "https://siragpt.dev/api/images/abc.png" }
    assert.equal(isImageOnlyMessageForRender(message, []), true)
  })

  it("does NOT match a non-image assistant URL", () => {
    const message = { role: "ASSISTANT", content: "https://example.com/article" }
    assert.equal(isImageOnlyMessageForRender(message, []), false)
  })

  it("does NOT match if the role is USER even with an image URL", () => {
    const message = {
      role: "USER",
      content: "https://oaidalleapiprodscus.blob.core.windows.net/x.png",
    }
    assert.equal(isImageOnlyMessageForRender(message, []), false)
  })
})

describe("isImageOnlyMessageForRender · image attachment detection", () => {
  it("recognises files via mimeType prefix image/*", () => {
    const message = { role: "USER", content: "" }
    const files = [{ id: "f1", mimeType: "image/webp" }]
    assert.equal(isImageOnlyMessageForRender(message, files), true)
  })

  it("recognises files via contentType field", () => {
    const message = { role: "USER", content: "" }
    const files = [{ id: "f1", contentType: "image/jpeg" }]
    assert.equal(isImageOnlyMessageForRender(message, files), true)
  })

  it("recognises files via name extension when MIME is missing", () => {
    const message = { role: "USER", content: "" }
    const files = [{ id: "f1", name: "photo.HEIC" }]
    assert.equal(isImageOnlyMessageForRender(message, files), true)
  })

  it("returns false when files exist but none are images", () => {
    const message = { role: "USER", content: "" }
    const files = [{ id: "f1", name: "report.pdf", mimeType: "application/pdf" }]
    assert.equal(isImageOnlyMessageForRender(message, files), false)
  })
})

describe("isImageOnlyMessageForRender · defensive input handling", () => {
  it("returns false when parsedFiles is not an array", () => {
    const message = { role: "USER", content: "" }
    // @ts-expect-error - exercising the runtime guard
    assert.equal(isImageOnlyMessageForRender(message, null), false)
    assert.equal(isImageOnlyMessageForRender(message, undefined), false)
    // @ts-expect-error - exercising the runtime guard
    assert.equal(isImageOnlyMessageForRender(message, "[]"), false)
  })

  it("treats visible whitespace-only content as NO text", () => {
    const message = { role: "USER", content: "    \n\t  " }
    const files = [{ id: "f1", mimeType: "image/png" }]
    assert.equal(isImageOnlyMessageForRender(message, files), true)
  })

  it("treats null / undefined content as NO text", () => {
    const message = { role: "USER", content: null }
    const files = [{ id: "f1", mimeType: "image/png" }]
    assert.equal(isImageOnlyMessageForRender(message, files), true)
  })

  it("coerces non-string content via String() before checking", () => {
    const message = { role: "USER", content: 42 }
    const files = [{ id: "f1", mimeType: "image/png" }]
    // "42" is visible text, so this is NOT image-only.
    assert.equal(isImageOnlyMessageForRender(message, files), false)
  })
})
