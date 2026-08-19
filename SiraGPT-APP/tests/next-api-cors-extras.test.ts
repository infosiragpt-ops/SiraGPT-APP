import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  isNextApiOriginAllowed,
  resolveNextApiAllowedOrigins,
} from "../lib/next-api-cors"

/**
 * Extras on top of the 3 base CORS-policy tests. Pins:
 *
 *   - CORS_ORIGINS env parsing (commas, whitespace, empty entries)
 *   - "*" / wildcard handling and how it interacts with explicit
 *     origins
 *   - isNextApiOriginAllowed branch coverage:
 *     no-origin, exact match, wildcard-allow-all, case sensitivity
 *   - Multi-environment edge: explicit CORS_ORIGINS wins even in dev
 */

describe("resolveNextApiAllowedOrigins · env parsing", () => {
  it("parses comma-separated CORS_ORIGINS", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://a.example.com,https://b.example.com",
    })
    assert.deepEqual(origins, [
      "https://a.example.com",
      "https://b.example.com",
    ])
  })

  it("trims whitespace around each entry", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "  https://a.example.com  ,   https://b.example.com   ",
    })
    assert.deepEqual(origins, [
      "https://a.example.com",
      "https://b.example.com",
    ])
  })

  it("filters out empty entries (consecutive commas)", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://a.example.com,,https://b.example.com,",
    })
    assert.deepEqual(origins, [
      "https://a.example.com",
      "https://b.example.com",
    ])
  })

  it("returns ['*'] when CORS_ORIGINS is literally '*'", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "*",
    })
    assert.deepEqual(origins, ["*"])
  })
})

describe("resolveNextApiAllowedOrigins · env precedence", () => {
  it("explicit CORS_ORIGINS wins over dev fallback (NODE_ENV !== production)", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "development",
      CORS_ORIGINS: "https://staging.example.com",
    })
    assert.deepEqual(origins, ["https://staging.example.com"])
    assert.equal(origins.includes("http://localhost:3000"), false)
  })

  it("uses dev fallback when NODE_ENV is undefined entirely", () => {
    const origins = resolveNextApiAllowedOrigins({})
    assert.ok(origins.includes("http://localhost:3000"))
  })

  it("returns [] for production when CORS_ORIGINS is empty string", () => {
    const origins = resolveNextApiAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "",
    })
    assert.deepEqual(origins, [])
  })
})

describe("isNextApiOriginAllowed · edge cases", () => {
  it("returns true for an empty-string origin (no header)", () => {
    // Treated like "no origin" — the request likely came from the
    // same-origin browser or curl, which we don't need to gate.
    assert.equal(isNextApiOriginAllowed("", ["https://example.com"]), true)
  })

  it("is case-sensitive on the origin scheme + host", () => {
    // CORS spec is case-sensitive on the origin string.
    assert.equal(
      isNextApiOriginAllowed("https://APP.example.com", [
        "https://app.example.com",
      ]),
      false,
    )
  })

  it("wildcard '*' wins regardless of any other allowlist entries", () => {
    assert.equal(
      isNextApiOriginAllowed("https://evil.example.com", [
        "https://app.example.com",
        "*",
      ]),
      true,
    )
  })

  it("empty allowlist + non-null origin returns false", () => {
    assert.equal(
      isNextApiOriginAllowed("https://app.example.com", []),
      false,
    )
  })
})
