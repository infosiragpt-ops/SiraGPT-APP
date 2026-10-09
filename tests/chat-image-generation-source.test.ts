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
  it("acknowledges a durable image job before provider work and keeps the worker independent of the HTTP socket", () => {
    const start = aiRoute.indexOf("async function handleChatImage(req, res)")
    const handler = aiRoute.slice(start, aiRoute.indexOf("// Add this route", start))
    assert.match(handler, /getMediaJobStore\(\)\.admit\(/, "admission must be committed before acknowledgement")
    assert.match(handler, /return res\.status\(202\)\.json\(\{ jobId: job\.id/, "acknowledge a recoverable job id")
    assert.ok(handler.indexOf("return res.status(202)") < handler.indexOf("const generateSingleImage"), "HTTP must return before provider execution")
    assert.match(handler, /if \(!mediaContext && !res\.writableEnded\) requestAbortController\.abort\(\)/, "only pre-admission HTTP validation belongs to the socket")
    assert.match(handler, /mediaContext\.signal\.addEventListener\('abort'/, "worker cancellation comes from the durable job controller")
    assert.match(handler, /_mediaJobContext: ctx/, "recovered workers must re-enter the same rendering/persistence implementation")
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
