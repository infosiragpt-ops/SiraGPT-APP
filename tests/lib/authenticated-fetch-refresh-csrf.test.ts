import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAuthenticatedFetch, invalidateAuthSession, SESSION_EXPIRED_EVENT } from "@/lib/authenticated-fetch"

const BASE = "https://api.sira.test/api"
const json = (status: number, body: object = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("cookie refresh CSRF boundary", () => {
  beforeEach(() => localStorage.setItem("auth-token", "expired"))
  afterEach(() => localStorage.clear())

  it("prepares cookie-only refresh with the server CSRF token", async () => {
    const paths: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(BASE.length)
      paths.push(path)
      if (path === "/auth/csrf-token") return json(200, { csrfToken: "csrf-current" })
      const headers = new Headers(init?.headers)
      if (path === "/auth/refresh") {
        expect(headers.has("Authorization")).toBe(false)
        expect(init?.credentials).toBe("include")
        return headers.get("X-CSRF-Token") === "csrf-current"
          ? json(200, { token: "refreshed" }) : json(403, { code: "csrf_invalid" })
      }
      return json(headers.get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => null })
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(paths).toEqual(["/resource", "/auth/csrf-token", "/auth/refresh", "/resource"])
  })

  it("renews a stale CSRF cookie once and preserves the original request", async () => {
    let refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) return json(200, { csrfToken: "csrf-current" })
      const headers = new Headers(init?.headers)
      if (String(input).endsWith("/auth/refresh")) {
        refreshes += 1
        expect(headers.has("Authorization")).toBe(false)
        return headers.get("X-CSRF-Token") === "csrf-current"
          ? json(200, { token: "refreshed" }) : json(403, { error: "csrf_invalid" })
      }
      return json(headers.get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => "csrf-stale" })
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(refreshes).toBe(2)
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/auth/csrf-token"))).toHaveLength(1)
  })

  it("does not expire the session after a persistent CSRF rejection", async () => {
    const expired = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      let refreshes = 0
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/auth/csrf-token")) return json(200, { csrfToken: "csrf-current" })
        if (String(input).endsWith("/auth/refresh")) { refreshes += 1; return json(403, { code: "csrf_invalid" }) }
        return json(401)
      })
      const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => "csrf-stale" })
      expect((await transport(BASE + "/resource")).status).toBe(401)
      expect(refreshes).toBe(2)
      expect(transport.sessionGuard.isBlocked("expired")).toBe(false)
      expect(expired).not.toHaveBeenCalled()
      expect(localStorage.getItem("auth-token")).toBe("expired")
    } finally { window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })

  it("leaves the session available when forced CSRF preparation fails", async () => {
    let refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/csrf-token")) throw new TypeError("network unavailable")
      if (String(input).endsWith("/auth/refresh")) { refreshes += 1; return json(403, { code: "csrf_invalid" }) }
      return json(401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => "csrf-stale" })
    expect((await transport(BASE + "/resource")).status).toBe(401)
    expect(refreshes).toBe(1)
    expect(transport.sessionGuard.isBlocked("expired")).toBe(false)
    expect(localStorage.getItem("auth-token")).toBe("expired")
  })

  it.each([401, 403])("keeps authentication rejection %s definitive", async status => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth/refresh")
      ? json(status, { error: "session_expired" }) : json(401))
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => "csrf-current" })
    expect((await transport(BASE + "/resource")).status).toBe(401)
    expect(transport.sessionGuard.isBlocked("expired")).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])("does not send a late refresh after identity changes during CSRF preparation (%s)", async stale => {
    const gate = deferred<Response>(), started = deferred<void>()
    let refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/csrf-token")) { started.resolve(); return gate.promise }
      if (String(input).endsWith("/auth/refresh")) { refreshes += 1; return json(403, { code: "csrf_invalid" }) }
      return json(401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => stale ? "csrf-stale" : null })
    const pending = transport(BASE + "/resource")
    await started.promise
    invalidateAuthSession(); localStorage.setItem("auth-token", "new-account")
    gate.resolve(json(200, { csrfToken: "csrf-current" }))
    expect((await pending).status).toBe(401)
    expect(refreshes).toBe(stale ? 1 : 0)
    expect(localStorage.getItem("auth-token")).toBe("new-account")
    expect(transport.sessionGuard.isBlocked("new-account")).toBe(false)
  })

  it("coalesces CSRF preparation and refresh across concurrent requests", async () => {
    const gate = deferred<Response>(), started = deferred<void>()
    let csrfGets = 0, refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) { csrfGets += 1; started.resolve(); return gate.promise }
      if (String(input).endsWith("/auth/refresh")) { refreshes += 1; return json(200, { token: "refreshed" }) }
      return json(new Headers(init?.headers).get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => null })
    const a = transport(BASE + "/first"), b = transport(BASE + "/second")
    await started.promise; gate.resolve(json(200, { csrfToken: "csrf-current" }))
    expect((await Promise.all([a, b])).map(r => r.status)).toEqual([200, 200])
    expect(csrfGets).toBe(1); expect(refreshes).toBe(1)
  })
})
