import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

// We only import the pure helper. The rest of lib/api.ts triggers
// fetch instrumentation on import which is fine in a node test
// runner — no network is hit until a method is called.
import { getNormalizedApiBaseUrl } from "../lib/api"

const ORIGINAL_API_URL = process.env.NEXT_PUBLIC_API_URL

describe("getNormalizedApiBaseUrl", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL
  })

  afterEach(() => {
    if (ORIGINAL_API_URL === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL
    } else {
      process.env.NEXT_PUBLIC_API_URL = ORIGINAL_API_URL
    }
  })

  it("falls back to http://localhost:5000/api when env is unset", () => {
    assert.equal(getNormalizedApiBaseUrl(), "http://localhost:5000/api")
  })

  it("appends /api when the env var omits it", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.dev"
    assert.equal(getNormalizedApiBaseUrl(), "https://api.siragpt.dev/api")
  })

  it("preserves /api suffix when the env var already has it", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.dev/api"
    assert.equal(getNormalizedApiBaseUrl(), "https://api.siragpt.dev/api")
  })

  it("strips a trailing slash before appending /api", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.dev/"
    assert.equal(getNormalizedApiBaseUrl(), "https://api.siragpt.dev/api")
  })

  it("strips a trailing slash even when /api is already present", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.dev/api/"
    assert.equal(getNormalizedApiBaseUrl(), "https://api.siragpt.dev/api")
  })

  it("handles a tunnel-style URL the same way", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://abc-xyz.trycloudflare.com"
    assert.equal(
      getNormalizedApiBaseUrl(),
      "https://abc-xyz.trycloudflare.com/api",
    )
  })
})
