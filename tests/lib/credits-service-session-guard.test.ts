import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { blockAuthRefresh, clearAuthRefreshBlock } from "@/lib/authenticated-fetch"
import { getMyCredits } from "@/lib/credits-service"

/**
 * The sidebar credits badge polls every 30 s (once a minute in a background
 * tab). Production 2026-10-07: eight `GET /api/credits/me → 401` per minute
 * for 2 h 20 m from a logged-out tab. While the shared transport knows the
 * session is over the badge asks the server nothing.
 */
describe("getMyCredits while the session is known to be over", () => {
  const originalFetch = globalThis.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    clearAuthRefreshBlock()
    mockFetch.mockReset()
    globalThis.fetch = mockFetch as unknown as typeof fetch
  })
  afterEach(() => {
    clearAuthRefreshBlock()
    globalThis.fetch = originalFetch
  })

  it("returns null without a request while the refresh guard is armed", async () => {
    blockAuthRefresh(null)

    await expect(getMyCredits()).resolves.toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("asks the server again once the guard is cleared or a new login token appears", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ credits: { balance: "42" } }), { status: 200, headers: { "Content-Type": "application/json" } }))
    blockAuthRefresh(null)
    await expect(getMyCredits()).resolves.toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()

    localStorage.setItem("auth-token", "fresh-login")
    const credits = await getMyCredits()
    expect(credits?.balance).toBe("42")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("still maps a plain 401 (session not yet known dead) to null", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 401, headers: { "Content-Type": "application/json" } }))
    await expect(getMyCredits()).resolves.toBeNull()
    // the request + the one refresh the transport is allowed to try
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
