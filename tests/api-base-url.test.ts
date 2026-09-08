import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { DEFAULT_API_BASE_URL, getNormalizedApiBaseUrl, getSameOriginApiBaseUrl } from "../lib/api-base-url"

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

  it("falls back to the default when an explicit value is empty", () => {
    assert.equal(getNormalizedApiBaseUrl("   "), DEFAULT_API_BASE_URL)
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

  it("strips repeated trailing slashes", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.dev///"
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

describe("getSameOriginApiBaseUrl", () => {
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it("uses the browser origin on siragpt.com and never api.siragpt.com", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.com/api"
    assert.equal(getSameOriginApiBaseUrl(undefined, "https://siragpt.com"), "https://siragpt.com/api")
    assert.doesNotMatch(getSameOriginApiBaseUrl(undefined, "https://siragpt.com"), /api\.siragpt\.com/)
  })

  it("does not use localhost:5000 in production when the env is unset", () => {
    process.env.NODE_ENV = "production"
    delete process.env.NEXT_PUBLIC_API_URL
    const base = getSameOriginApiBaseUrl(undefined, "")
    assert.equal(base, "/api")
    assert.doesNotMatch(base, /localhost:5000/)
  })

  it("rewrites a baked api.siragpt.com env to /api without a window", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.siragpt.com/api"
    assert.equal(getSameOriginApiBaseUrl(), "/api")
  })
})
