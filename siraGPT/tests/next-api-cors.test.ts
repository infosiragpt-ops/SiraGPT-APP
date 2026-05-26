import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isNextApiOriginAllowed,
  resolveNextApiAllowedOrigins,
} from "../lib/next-api-cors"

describe("Next API CORS policy", () => {
  it("fails closed in production when CORS_ORIGINS is not configured", () => {
    assert.deepEqual(resolveNextApiAllowedOrigins({ NODE_ENV: "production" }), [])
  })

  it("uses local development fallbacks outside production", () => {
    const origins = resolveNextApiAllowedOrigins({ NODE_ENV: "development" })

    assert.ok(origins.includes("http://localhost:3000"))
    assert.ok(origins.includes("http://127.0.0.1:3000"))
  })

  it("requires an exact allowlist match unless wildcard is explicit", () => {
    const allowed = ["https://app.example.com"]

    assert.equal(isNextApiOriginAllowed("https://app.example.com", allowed), true)
    assert.equal(isNextApiOriginAllowed("https://evil.example.com", allowed), false)
    assert.equal(isNextApiOriginAllowed(null, allowed), true)
    assert.equal(isNextApiOriginAllowed("https://evil.example.com", ["*"]), true)
  })
})
