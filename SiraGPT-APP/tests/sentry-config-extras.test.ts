import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  clampSampleRate,
  resolveClientSentryConfig,
} from "../lib/sentry-config"

/**
 * Extras on top of the 3 base sentry-config tests. Pins:
 *
 *   - clampSampleRate input shapes: undefined / empty / "0" / "0.5" / "1" /
 *     out-of-range / non-numeric / negative-zero edge
 *   - resolveClientSentryConfig DSN trimming, env fallback chain,
 *     release passthrough vs undefined, defaults when sample rates
 *     are missing entirely
 */

describe("clampSampleRate · all input shapes", () => {
  it("returns the fallback for undefined / empty / whitespace input", () => {
    assert.equal(clampSampleRate(undefined, 0.5), 0.5)
    assert.equal(clampSampleRate("", 0.5), 0.5)
    assert.equal(clampSampleRate("   ", 0.5), 0.5)
  })

  it("passes through valid decimals in [0, 1]", () => {
    assert.equal(clampSampleRate("0", 0.5), 0)
    assert.equal(clampSampleRate("0.5", 0.5), 0.5)
    assert.equal(clampSampleRate("1", 0.5), 1)
  })

  it("uses default fallback of 0 when not specified", () => {
    assert.equal(clampSampleRate(undefined), 0)
    assert.equal(clampSampleRate("bad"), 0)
  })

  it("clamps negative-infinity / NaN to fallback", () => {
    assert.equal(clampSampleRate("-Infinity", 0.3), 0.3)
    assert.equal(clampSampleRate("NaN", 0.3), 0.3)
  })

  it("clamps any positive number > 1 to exactly 1", () => {
    assert.equal(clampSampleRate("1.5", 0), 1)
    assert.equal(clampSampleRate("100", 0), 1)
    assert.equal(clampSampleRate("1e6", 0), 1)
  })
})

describe("resolveClientSentryConfig · DSN handling", () => {
  it("returns null when dsn is empty / whitespace / missing", () => {
    assert.equal(resolveClientSentryConfig({}), null)
    assert.equal(resolveClientSentryConfig({ dsn: "" }), null)
    assert.equal(resolveClientSentryConfig({ dsn: "   " }), null)
  })

  it("trims dsn before returning", () => {
    const config = resolveClientSentryConfig({
      dsn: "  https://public@example.com/1  ",
    })
    assert.equal(config?.dsn, "https://public@example.com/1")
  })
})

describe("resolveClientSentryConfig · environment fallback", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  beforeEach(() => {
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV
  })

  it("uses explicit environment when provided", () => {
    const config = resolveClientSentryConfig({
      dsn: "x",
      environment: "staging",
    })
    assert.equal(config?.environment, "staging")
  })

  it("falls back to NODE_ENV when no explicit environment", () => {
    process.env.NODE_ENV = "production"
    const config = resolveClientSentryConfig({ dsn: "x" })
    assert.equal(config?.environment, "production")
  })

  it("falls back to 'development' when neither is set", () => {
    delete process.env.NODE_ENV
    const config = resolveClientSentryConfig({ dsn: "x" })
    assert.equal(config?.environment, "development")
  })
})

describe("resolveClientSentryConfig · release passthrough", () => {
  it("passes release through verbatim when present", () => {
    const config = resolveClientSentryConfig({
      dsn: "x",
      release: "siragpt@1.2.3",
    })
    assert.equal(config?.release, "siragpt@1.2.3")
  })

  it("leaves release as undefined when not provided", () => {
    const config = resolveClientSentryConfig({ dsn: "x" })
    assert.equal(config?.release, undefined)
  })

  it("treats empty-string release as missing (undefined)", () => {
    const config = resolveClientSentryConfig({ dsn: "x", release: "" })
    assert.equal(config?.release, undefined)
  })
})

describe("resolveClientSentryConfig · sample-rate defaults", () => {
  it("defaults all three sample rates to 0 when none are configured", () => {
    const config = resolveClientSentryConfig({ dsn: "x" })
    assert.equal(config?.tracesSampleRate, 0)
    assert.equal(config?.replaysSessionSampleRate, 0)
    assert.equal(config?.replaysOnErrorSampleRate, 0)
  })

  it("hard-codes sendDefaultPii: false regardless of input", () => {
    const config = resolveClientSentryConfig({ dsn: "x" })
    assert.equal(config?.sendDefaultPii, false)
  })
})
