import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AUTH_REFRESH_FAILURE_COOLDOWN_MS,
  SESSION_EXPIRED_EVENT,
  authenticatedFetch,
  blockAuthRefresh,
  clearAuthRefreshBlock,
  createAuthenticatedFetch,
  isAuthRefreshBlocked,
} from "@/lib/authenticated-fetch"

const API_BASE = "https://api.sira.test/api"

function jsonResponse(status: number, body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/**
 * Production 2026-10-07, 20:15 → 22:37 UTC: one logged-out tab emitted every
 * minute (Chrome wakes background timers once a minute) eight
 * `GET /api/credits/me → 401`, one `/agent-computer/activity → 401`, one
 * `/login-handoff → 401` and NINE `POST /api/auth/refresh → 401`: the shared
 * transport refreshed on every 401 even though the refresh endpoint had
 * already said the session was over. The guard remembers that answer.
 */
describe("authenticatedFetch session guard", () => {
  beforeEach(() => {
    localStorage.clear()
    // Session-guard cases start with a valid CSRF cookie.
    document.cookie = "csrf_token=session-guard-csrf; path=/"
    clearAuthRefreshBlock()
  })
  afterEach(() => {
    document.cookie = "csrf_token=; Max-Age=0; path=/"
    clearAuthRefreshBlock()
    vi.useRealTimers()
  })

  function countRefreshes(fetchImpl: ReturnType<typeof vi.fn>): number {
    return fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/auth/refresh")).length
  }

  it("refreshes once per dead session: after /auth/refresh answers 401 later 401s are returned without a refresh", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "Invalid or expired token" }))
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })

    for (let i = 0; i < 8; i += 1) {
      const res = await fetchAuth(`${API_BASE}/credits/me`)
      expect(res.status).toBe(401)
    }

    expect(countRefreshes(fetchImpl)).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(9)
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(true)
  })

  it("treats 403 from the refresh endpoint as final too, but not a 5xx or a network error", async () => {
    let refreshStatus = 403
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/refresh")) {
        if (refreshStatus === 0) throw new TypeError("network down")
        return jsonResponse(refreshStatus, { error: "refresh rejected" })
      }
      return jsonResponse(401, { error: "expired" })
    })
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })

    await fetchAuth(`${API_BASE}/credits/me`)
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(true)

    fetchAuth.sessionGuard.clear()
    refreshStatus = 503
    await fetchAuth(`${API_BASE}/credits/me`)
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(false)

    refreshStatus = 0
    await fetchAuth(`${API_BASE}/credits/me`)
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(false)
    expect(countRefreshes(fetchImpl)).toBe(3)
  })

  it("lifts the block when the bearer changes (a login in another tab) and when the cooldown expires", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-07T20:15:47Z"))
    let bearer: string | null = "stale-token"
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "expired" }))
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => bearer })

    await fetchAuth(`${API_BASE}/credits/me`)
    await fetchAuth(`${API_BASE}/credits/me`)
    expect(countRefreshes(fetchImpl)).toBe(1)

    bearer = "fresh-token-from-other-tab"
    await fetchAuth(`${API_BASE}/credits/me`)
    expect(countRefreshes(fetchImpl)).toBe(2)
    expect(fetchAuth.sessionGuard.isBlocked(bearer)).toBe(true)

    vi.setSystemTime(Date.now() + AUTH_REFRESH_FAILURE_COOLDOWN_MS + 1)
    await fetchAuth(`${API_BASE}/credits/me`)
    expect(countRefreshes(fetchImpl)).toBe(3)
  })

  it("lifts the block after a credential handshake succeeds in this tab", async () => {
    let loggedIn = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/auth/login")) return jsonResponse(200, { token: "t" })
      if (url.endsWith("/auth/refresh")) return jsonResponse(loggedIn ? 200 : 401, loggedIn ? { token: "t2" } : {})
      return jsonResponse(loggedIn ? 200 : 401, {})
    })
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })

    await fetchAuth(`${API_BASE}/credits/me`)
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(true)

    await fetchAuth(`${API_BASE}/auth/login`, { method: "POST", body: "{}" })
    expect(fetchAuth.sessionGuard.isBlocked(null)).toBe(false)
  })

  it("tells the app once per block that the session expired", async () => {
    const seen = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, seen)
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(401, {}))
      const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
      await fetchAuth(`${API_BASE}/credits/me`)
      await fetchAuth(`${API_BASE}/agent-computer/activity`)
      await fetchAuth(`${API_BASE}/agent-computer/login-handoff`)
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, seen)
    }
  })

  it("never withholds the request itself: only the automatic refresh", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {}))
    const fetchAuth = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl: fetchImpl as typeof fetch, getBearerToken: () => null })
    fetchAuth.sessionGuard.block(null)

    const res = await fetchAuth(`${API_BASE}/agent-computer/activity?sessionId=ac_1&browser=1`)

    expect(res.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(countRefreshes(fetchImpl)).toBe(0)
  })

  it("exposes the shared transport's guard to callers that must stay quiet", () => {
    expect(isAuthRefreshBlocked()).toBe(false)
    blockAuthRefresh(null)
    expect(isAuthRefreshBlocked()).toBe(true)
    expect(authenticatedFetch.sessionGuard.isBlocked(null)).toBe(true)
    localStorage.setItem("auth-token", "new-login")
    expect(isAuthRefreshBlocked()).toBe(false)
    clearAuthRefreshBlock()
  })
})
