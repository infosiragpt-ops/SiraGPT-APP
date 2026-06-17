import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const aiRoutePath = path.join(process.cwd(), "backend", "src", "routes", "ai.js")
const chatInterfacePath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const apiClientPath = path.join(process.cwd(), "lib", "api.ts")

const aiRoute = fs.readFileSync(aiRoutePath, "utf8")
const chatInterface = fs.readFileSync(chatInterfacePath, "utf8")
const apiClient = fs.readFileSync(apiClientPath, "utf8")

describe("chat image generation resilience source contract", () => {
  it("keeps image generation alive after mobile/proxy socket close when a chat can persist the result", () => {
    assert.match(
      aiRoute,
      /if\s*\(!detachOnDisconnect\)\s*\{\s*requestAbortController\.abort\(\);\s*\}/,
      "server should only abort a closed image request before a valid chat persistence target exists"
    )
    assert.match(
      aiRoute,
      /requestAbortController\.signal\.aborted\s*&&\s*!clientDisconnected/,
      "server should not treat a disconnected mobile/proxy socket as a real user abort"
    )
  })

  it("polls the chat for generated images on recoverable long transport cuts", () => {
    assert.match(
      chatInterface,
      /shouldRecoverImageGenerationViaPolling\(genError,\s*imageRequestStartedAt/,
      "client should delegate image transport-cut recovery to the shared helper"
    )
    assert.doesNotMatch(
      chatInterface,
      /connectionCut[\s\S]{0,120}elapsed\s*>=\s*25000/,
      "client must not wait 25 seconds before recovering image generations on mobile connection cuts"
    )
  })

  it("starts chat polling while a long image request is still hung behind the proxy", () => {
    assert.match(
      apiClient,
      /resolveImageRequestWithChatRecovery\(requestPromise,\s*\{\s*chatId:\s*data\.chatId/,
      "image generation should race the long request with chat persistence recovery"
    )
    assert.match(
      apiClient,
      /const\s+edgeRecoveryDelayMs\s*=\s*Math\.min\(31_000/,
      "client should begin polling after the known 30s proxy edge instead of waiting for the 210s request timeout"
    )
    assert.match(
      apiClient,
      /outcome\s*===\s*'image'[\s\S]{0,80}recoveredFromChat/,
      "chat polling should resolve image generation as recovered when the backend persisted the image"
    )
    assert.match(
      apiClient,
      /suppressFailureLog:\s*true/,
      "recoverable image requests should not emit dev-overlay console errors when the long fetch times out later"
    )
    assert.match(
      apiClient,
      /La generación de imagen tardó demasiado/,
      "image timeouts that cannot be recovered should surface a user-facing Spanish message instead of the raw 210000ms timeout"
    )
  })

  it("stores generated upload URLs as public-safe relative paths unless a public media base is configured", () => {
    assert.match(
      aiRoute,
      /function\s+publicUploadUrl\(/,
      "server should centralize upload URL construction"
    )
    assert.match(
      aiRoute,
      /const\s+imageUrl\s*=\s*publicUploadUrl\(`\/uploads\/images\/\$\{filename\}`\)/,
      "generated image messages should not bake stale localhost BASE_URL values into chat files"
    )
    assert.doesNotMatch(
      aiRoute,
      /const\s+imageUrl\s*=\s*`\$\{baseUrl\}\/uploads\/images\/\$\{filename\}`/,
      "generated image URL must not use BASE_URL/PORT fallback"
    )
  })
})
