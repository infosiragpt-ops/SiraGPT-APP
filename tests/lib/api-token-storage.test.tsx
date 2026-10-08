import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/client-logs", () => ({ reportClientLog: vi.fn() }))

import { apiClient as api } from "@/lib/api"
import { authenticatedFetch, clearAuthRefreshBlock, clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function blockLocalStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage")
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError") },
  })
  return () => { if (original) Object.defineProperty(window, "localStorage", original) }
}

describe("ApiClient · storage and transport policy", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    api.setToken(null)
    clearAuthenticatedFetchCsrfCache()
    clearAuthRefreshBlock()
    vi.spyOn(authenticatedFetch.csrfManager, "getToken").mockResolvedValue(null)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    api.setToken(null)
  })

  it("keeps working when localStorage throws (Safari private mode): token lives in memory", async () => {
    const restore = blockLocalStorage()
    try {
      expect(() => api.setToken("mem-token")).not.toThrow()
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "u1" }), { status: 200 }))
      await api.getCurrentUser()
      const [, init] = mockFetch.mock.calls[0]
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer mem-token")
      expect(() => api.setToken(null)).not.toThrow()
    } finally {
      restore()
    }
  })

  it("persists the token when storage is available", () => {
    api.setToken("stored-token")
    expect(localStorage.getItem("auth-token")).toBe("stored-token")
    api.setToken(null)
    expect(localStorage.getItem("auth-token")).toBeNull()
  })

  it("a rate-limited GET is sent once per attempt: the transport does not double the ApiClient retry", async () => {
    vi.useFakeTimers()
    try {
      mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      }))
      const pending = api.getCurrentUser().catch((error: unknown) => error)
      // Attempt 0 → wait 1 s → attempt 1 → wait 1 s → attempt 2 (MAX_RETRIES = 2).
      await vi.advanceTimersByTimeAsync(5_000)
      const error = await pending as { status?: number }
      expect(error.status).toBe(429)
      expect(mockFetch).toHaveBeenCalledTimes(3)
      for (const [url] of mockFetch.mock.calls) expect(String(url)).toMatch(/\/auth\/me$/)
    } finally {
      vi.useRealTimers()
    }
  })
})
