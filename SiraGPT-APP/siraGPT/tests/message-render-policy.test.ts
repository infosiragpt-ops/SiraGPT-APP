import test from "node:test"
import assert from "node:assert/strict"

import { isImageOnlyMessageForRender } from "../lib/message-render-policy"

test("user image uploads with visible instructions are not rendered as image-only", () => {
  const message = { role: "USER", content: "transcribir" }
  const files = [{ id: "img-1", type: "image", mimeType: "image/png" }]

  assert.equal(isImageOnlyMessageForRender(message, files), false)
})

test("empty image upload bubbles may suppress markdown text", () => {
  const message = { role: "USER", content: "   " }
  const files = [{ id: "img-1", type: "image", mimeType: "image/png" }]

  assert.equal(isImageOnlyMessageForRender(message, files), true)
})

test("assistant generated image URL still suppresses markdown rendering", () => {
  const message = { role: "ASSISTANT", content: "https://cdn.example.com/api/images/generated.png" }

  assert.equal(isImageOnlyMessageForRender(message, []), true)
})
