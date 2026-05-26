import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { aiService, normalizeRoutingIntent } from "../lib/ai-service"
import { buildDocumentChatRequest } from "../lib/document-chat-request"

describe("ppt routing · document artifact pipeline", () => {
  it("routes PPT requests to the downloadable document pipeline", async () => {
    const intent = await aiService.classifyIntent("crea una ppt sobre el marketing")
    const request = buildDocumentChatRequest({ prompt: "crea una ppt sobre el marketing" })

    assert.equal(intent, "doc")
    assert.equal(normalizeRoutingIntent("ppt"), "doc")
    assert.equal(request.format, "pptx")
  })
})
