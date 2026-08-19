import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clampSampleRate, resolveClientSentryConfig } from "../lib/sentry-config"

describe("sentry-config", () => {
  it("stays disabled without a DSN", () => {
    assert.equal(resolveClientSentryConfig({}), null)
  })

  it("builds a privacy-preserving browser config", () => {
    const config = resolveClientSentryConfig({
      dsn: "https://public@example.com/1",
      environment: "production",
      tracesSampleRate: "0.25",
      replaySessionSampleRate: "2",
      replayOnErrorSampleRate: "bad",
    })

    assert.equal(config?.environment, "production")
    assert.equal(config?.tracesSampleRate, 0.25)
    assert.equal(config?.replaysSessionSampleRate, 1)
    assert.equal(config?.replaysOnErrorSampleRate, 0)
    assert.equal(config?.sendDefaultPii, false)
  })

  it("clamps sample rates", () => {
    assert.equal(clampSampleRate("-1", 0.2), 0)
    assert.equal(clampSampleRate("3", 0.2), 1)
    assert.equal(clampSampleRate("bad", 0.2), 0.2)
  })
})
