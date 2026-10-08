import { describe, expect, it, vi } from "vitest"

import {
  TRANSIENT_RETRY_MAX_WAIT_MS,
  createAuthenticatedFetch,
  parseRetryAfterMs,
} from "@/lib/authenticated-fetch"

const API_BASE = "https://api.sira.test/api"

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ status }), { status, headers: { "Content-Type": "application/json", ...headers } })
}

/**
 * The transport refetched every trusted GET once after a 429/502/503/504 even
 * for callers (ApiClient) that already retry with their own Retry-After
 * policy: a rate-limited server was hit twice per attempt. `retryTransient:
 * false` opts out; the transport's own wait now honours Retry-After on 503
 * too and never refetches an aborted request.
 */
describe("authenticatedFetch · transient retries", () => {
  it("parseRetryAfterMs reads delta-seconds and HTTP-dates, null otherwise", () => {
    const now = () => Date.parse("2026-10-08T10:00:00Z")
    expect(parseRetryAfterMs("3", now)).toBe(3_000)
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0)
    expect(parseRetryAfterMs("Thu, 08 Oct 2026 10:00:05 GMT", now)).toBe(5_000)
    expect(parseRetryAfterMs("Thu, 08 Oct 2026 09:00:00 GMT", now)).toBe(0)
    expect(parseRetryAfterMs("soon", now)).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs("")).toBeNull()
  })

  it("refetches a trusted GET once after 429 by default, waiting Retry-After (capped)", async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(response(429, { "Retry-After": "60" }))
        .mockResolvedValueOnce(response(200))
      const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
      const pending = fetchAuth(`${API_BASE}/credits/me`)
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_MAX_WAIT_MS - 1)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      const res = await pending
      expect(res.status).toBe(200)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("honours Retry-After on 503 (previously a fixed 250 ms)", async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(response(503, { "Retry-After": "1" }))
        .mockResolvedValueOnce(response(200))
      const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
      const pending = fetchAuth(`${API_BASE}/health`)
      await vi.advanceTimersByTimeAsync(999)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect((await pending).status).toBe(200)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retryTransient:false returns the 429/503 to a caller with its own policy — one request", async () => {
    for (const status of [429, 502, 503, 504]) {
      const fetchImpl = vi.fn().mockResolvedValue(response(status, { "Retry-After": "1" }))
      const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
      const res = await fetchAuth(`${API_BASE}/credits/me`, {}, { retryTransient: false })
      expect(res.status).toBe(status)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it("never refetches once the caller aborted during the wait", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchImpl = vi.fn().mockResolvedValue(response(503))
      const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
      const pending = fetchAuth(`${API_BASE}/health`, { signal: controller.signal })
      controller.abort()
      await vi.advanceTimersByTimeAsync(1_000)
      expect((await pending).status).toBe(503)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("mutations and external origins are never refetched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503))
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null, readCsrfCookie: () => "csrf" })
    await fetchAuth(`${API_BASE}/chats`, { method: "POST", body: "{}" })
    await fetchAuth("https://example.org/status")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
