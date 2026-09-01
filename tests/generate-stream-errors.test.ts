import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  CONNECTION_UNAVAILABLE_MESSAGE,
  attachGenerateHttpError,
  friendlyGenerateHttpError,
  isConnectionUnavailablePayload,
  isCsrfInvalidPayload,
  isDeadGenerateConnection,
  isGenerateHttpTerminal,
  shouldRetryGenerateHttp,
} from "../lib/generate-stream-errors"

describe("generate HTTP errors stop thinking", () => {
  it("treats 503 / connection_unavailable as terminal even with an empty body", () => {
    assert.equal(isDeadGenerateConnection(503, {}), true)
    assert.equal(isGenerateHttpTerminal(503, {}), true)
    assert.equal(isGenerateHttpTerminal(503, { error: "connection_unavailable" }), true)
    assert.equal(isConnectionUnavailablePayload({ error: "connection_unavailable" }), true)
    assert.equal(
      shouldRetryGenerateHttp(503, { error: "connection_unavailable" }, { attempt: 1, maxAttempts: 5 }),
      false,
    )
    assert.equal(shouldRetryGenerateHttp(503, {}, { attempt: 1, maxAttempts: 5 }), false)
    assert.equal(friendlyGenerateHttpError(503, {}), CONNECTION_UNAVAILABLE_MESSAGE)
    assert.equal(
      friendlyGenerateHttpError(503, { error: "connection_unavailable", message: CONNECTION_UNAVAILABLE_MESSAGE }),
      CONNECTION_UNAVAILABLE_MESSAGE,
    )
    const err = attachGenerateHttpError(503, { error: "connection_unavailable" })
    assert.equal(err.status, 503)
    assert.equal(err.code, "connection_unavailable")
    assert.equal(err.message, CONNECTION_UNAVAILABLE_MESSAGE)
  })

  it("does not remap a picked Anthropic / xAI id to Kimi in the generate client", async () => {
    const apiSource = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")
    assert.match(apiSource, /attachGenerateHttpError/)
    assert.match(apiSource, /shouldRetryGenerateHttp/)
    assert.match(apiSource, /pinGenerateRequest\(\{ model: data\.model, provider: data\.provider \}\)/)

    const { resolveCatalogModel } = await import("../lib/chat/catalog-model")
    assert.deepEqual(
      resolveCatalogModel("anthropic/claude-sonnet-5", [], "Kimi"),
      { name: "anthropic/claude-sonnet-5", provider: "Anthropic", replaced: false },
    )
    assert.deepEqual(
      resolveCatalogModel("x-ai/grok-4.5", [], "Kimi"),
      { name: "x-ai/grok-4.5", provider: "xAI", replaced: false },
    )
    assert.notEqual(resolveCatalogModel("x-ai/grok-4.5", [], "Kimi").name, "moonshotai/kimi-k2.7-code")
  })

  it("keeps provider 5xx / 429 / retryable 409 retryable; 503 and other 4xx stop immediately", () => {
    assert.equal(shouldRetryGenerateHttp(429, {}, { attempt: 1, maxAttempts: 5 }), true)
    assert.equal(shouldRetryGenerateHttp(408, {}, { attempt: 1, maxAttempts: 5 }), true)
    assert.equal(shouldRetryGenerateHttp(409, { retryable: true }, { attempt: 1, maxAttempts: 5 }), true)
    assert.equal(shouldRetryGenerateHttp(409, {}, { attempt: 1, maxAttempts: 5 }), false)
    assert.equal(shouldRetryGenerateHttp(401, {}, { attempt: 1, maxAttempts: 5 }), false)
    assert.equal(shouldRetryGenerateHttp(500, { error: "provider unavailable 1" }, { attempt: 1, maxAttempts: 5 }), true)
    assert.equal(shouldRetryGenerateHttp(502, {}, { attempt: 1, maxAttempts: 5 }), true)
    assert.equal(isCsrfInvalidPayload({ error: "csrf_invalid" }), true)
    assert.equal(shouldRetryGenerateHttp(403, { error: "csrf_invalid" }, { attempt: 1, maxAttempts: 5 }), false)
    assert.equal(isGenerateHttpTerminal(400, { error: "bad_request" }), true)
  })

  it("keeps cookie/CSRF reconnect and cursor resume in the generate client", () => {
    const apiSource = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")
    assert.match(
      apiSource,
      /isNetworkError && attempt < MAX_CONNECT_ATTEMPTS && \(canResume \|\| !hasDeliveredAnyContent\)/,
    )
    assert.match(apiSource, /canResume \? 'resuming' : 'reconnecting'/)
    assert.match(apiSource, /hasResumeCursor: Boolean\(lastEventId\)/)
  })
})
