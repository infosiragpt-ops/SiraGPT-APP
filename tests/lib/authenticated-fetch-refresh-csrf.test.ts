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
      expect((await transport(BASE + "/resource")).status).toBe(403)
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
    expect((await transport(BASE + "/resource")).status).toBe(403)
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

describe("persistent refresh CSRF recovery", () => {
  beforeEach(() => localStorage.setItem("auth-token", "expired"))
  afterEach(() => localStorage.clear())

  function fixture() {
    let cookie: string | null = "csrf-stale"
    let repaired = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) return json(200, { csrfToken: repaired ? "csrf-repaired" : "csrf-rejected" })
      if (String(input).endsWith("/auth/refresh")) {
        if (repaired && new Headers(init?.headers).get("X-CSRF-Token") === "csrf-repaired") {
          return json(200, { token: "refreshed" })
        }
        return json(403, { code: "csrf_invalid", error: "Refresh the page to renew the security token" })
      }
      return json(new Headers(init?.headers).get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => cookie })
    return { transport, fetchImpl, repair: () => { repaired = true; cookie = "csrf-repaired" }, repairServer: () => { repaired = true } }
  }

  it("returns the actionable CSRF failure and stops sequential pollers from renewing it", async () => {
    const { transport, fetchImpl } = fixture()
    const expired = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      const responses: Response[] = []
      for (let i = 0; i < 8; i++) responses.push(await transport(BASE + "/resource"))
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(2)
      for (const response of responses) {
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: "csrf_invalid" })
      }
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/auth/csrf-token"))).toHaveLength(1)
      expect(localStorage.getItem("auth-token")).toBe("expired")
      expect(expired).not.toHaveBeenCalled()
    } finally { window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })

  it("shares a failed recovery across concurrent pollers and later waves", async () => {
    const { transport, fetchImpl } = fixture()
    for (let wave = 0; wave < 3; wave++) {
      const responses = await Promise.all(Array.from({ length: 8 }, () => transport(BASE + "/resource")))
      for (const response of responses) {
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: "csrf_invalid" })
      }
    }
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(2)
  })

  it.each(["cookie", "token", "epoch", "clear"])("allows a fresh recovery after %s changes", async change => {
    const { transport, fetchImpl, repair, repairServer } = fixture()
    await transport(BASE + "/resource")
    if (change === "cookie") repair()
    else {
      repairServer()
      if (change === "token") localStorage.setItem("auth-token", "new-session")
      if (change === "epoch") invalidateAuthSession()
      if (change === "clear") transport.csrfManager.clear()
    }
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(change === "cookie" ? 3 : 4)
  })

  it("does not arm the failure for a CSRF cookie rotated while the rejected request was pending", async () => {
    let cookie = "csrf-stale", attempts = 0
    const gate = deferred<Response>(), started = deferred<void>()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) return json(200, { csrfToken: "csrf-current" })
      if (String(input).endsWith("/auth/refresh")) {
        attempts++
        if (attempts === 2) { started.resolve(); return gate.promise }
        return attempts > 2 ? json(200, { token: "refreshed" }) : json(403, { code: "csrf_invalid" })
      }
      return json(new Headers(init?.headers).get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => cookie })
    const pending = transport(BASE + "/resource")
    await started.promise
    cookie = "csrf-repaired"
    gate.resolve(json(403, { code: "csrf_invalid" }))
    expect((await pending).status).toBe(403)
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(attempts).toBe(3)
  })
})

describe("failed CSRF preparation recovery", () => {
  beforeEach(() => localStorage.setItem("auth-token", "expired"))
  afterEach(() => localStorage.clear())

  it("remembers the CSRF cause when its token endpoint fails and recovers when a new token arrives", async () => {
    let repaired = false
    let csrfGets = 0, refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) {
        csrfGets++
        return repaired ? json(200, { csrfToken: "csrf-repaired" }) : json(503)
      }
      if (String(input).endsWith("/auth/refresh")) {
        refreshes++
        return repaired && new Headers(init?.headers).get("X-CSRF-Token") === "csrf-repaired"
          ? json(200, { token: "refreshed" }) : json(403, { code: "csrf_invalid" })
      }
      return json(new Headers(init?.headers).get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => null })
    for (let i = 0; i < 8; i++) expect((await transport(BASE + "/resource")).status).toBe(403)
    expect(refreshes).toBe(1)
    expect(csrfGets).toBe(2)
    repaired = true
    expect(await transport.csrfManager.getToken()).toBe("csrf-repaired")
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(refreshes).toBe(2)
  })

  it("does not add an authentication replay after the single CSRF retry", async () => {
    let mutations = 0, refreshes = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/csrf-token")) return json(200, { csrfToken: "csrf-current" })
      if (String(input).endsWith("/auth/refresh")) { refreshes++; return json(200, { token: "refreshed" }) }
      return ++mutations === 1 ? json(403, { code: "csrf_invalid" }) : json(401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => "csrf-stale" })
    expect((await transport(BASE + "/resource", { method: "POST" }, { bearerToken: null })).status).toBe(401)
    expect(mutations).toBe(2)
    expect(refreshes).toBe(0)
  })
  it("uses the current cookie rather than a stale token response arriving after another tab rotated it", async () => {
    let cookie = "csrf-stale", refreshes = 0
    const gate = deferred<Response>(), started = deferred<void>()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/csrf-token")) { started.resolve(); return gate.promise }
      const headers = new Headers(init?.headers)
      if (String(input).endsWith("/auth/refresh")) {
        refreshes++
        return headers.get("X-CSRF-Token") === "csrf-repaired"
          ? json(200, { token: "refreshed" }) : json(403, { code: "csrf_invalid" })
      }
      return json(headers.get("Authorization") === "Bearer refreshed" ? 200 : 401)
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => cookie })
    const pending = transport(BASE + "/resource")
    await started.promise
    cookie = "csrf-repaired"
    gate.resolve(json(200, { csrfToken: "csrf-stale-response" }))
    expect((await pending).status).toBe(200)
    expect(await transport.csrfManager.getToken()).toBe("csrf-repaired")
    expect((await transport(BASE + "/resource")).status).toBe(200)
    expect(refreshes).toBe(2)
  })

  it("does not restore an old CSRF response after a newer forced refresh finished", async () => {
    const first = deferred<Response>(), started = deferred<void>()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      if (++calls === 1) { started.resolve(); return first.promise }
      return json(200, { csrfToken: "csrf-newer" })
    })
    const transport = createAuthenticatedFetch({ apiBaseUrl: BASE, fetchImpl: fetchImpl as typeof fetch, readCsrfCookie: () => null })
    const oldRequest = transport.csrfManager.getToken(true)
    await started.promise
    expect(await transport.csrfManager.getToken(true)).toBe("csrf-newer")
    first.resolve(json(200, { csrfToken: "csrf-obsolete" }))
    expect(await oldRequest).toBe("csrf-newer")
    expect(await transport.csrfManager.getToken()).toBe("csrf-newer")
    expect(calls).toBe(2)
  })

})
