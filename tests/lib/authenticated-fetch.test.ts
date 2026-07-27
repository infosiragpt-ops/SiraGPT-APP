import { beforeEach, describe, expect, it, vi } from "vitest"

import { createAuthenticatedFetch } from "@/lib/authenticated-fetch"

const API_BASE = "https://api.sira.test/api"

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("authenticatedFetch", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("always includes credentials on a trusted GET and uses the optional localStorage bearer", async () => {
    localStorage.setItem("auth-token", "local-bearer")
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const authenticatedFetch = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl })

    await authenticatedFetch(`${API_BASE}/projects`)

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.credentials).toBe("include")
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer local-bearer")
    expect(new Headers(init.headers).has("X-CSRF-Token")).toBe(false)
  })

  it("obtains and caches one CSRF token for cookie-only mutations", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${API_BASE}/auth/csrf-token`) {
        return jsonResponse(200, { csrfToken: "csrf-cached" })
      }
      return jsonResponse(200, { ok: true })
    })
    const authenticatedFetch = createAuthenticatedFetch({
      apiBaseUrl: API_BASE,
      fetchImpl: fetchImpl as typeof fetch,
      getBearerToken: () => null,
      readCsrfCookie: () => null,
    })

    await authenticatedFetch(`${API_BASE}/projects`, { method: "POST", body: "{}" })
    await authenticatedFetch(`${API_BASE}/projects/second`, { method: "DELETE" })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/auth/csrf-token"))).toHaveLength(1)
    for (const [, init] of fetchImpl.mock.calls.filter(([input]) => !String(input).endsWith("/auth/csrf-token"))) {
      expect(init?.credentials).toBe("include")
      expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-cached")
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
    }
  })

  it("keeps bearer mutations CSRF-free", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const authenticatedFetch = createAuthenticatedFetch({
      apiBaseUrl: API_BASE,
      fetchImpl,
      getBearerToken: () => "explicit-bearer",
    })

    await authenticatedFetch(`${API_BASE}/design`, { method: "POST", body: "{}" })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = fetchImpl.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(init.credentials).toBe("include")
    expect(headers.get("Authorization")).toBe("Bearer explicit-bearer")
    expect(headers.has("X-CSRF-Token")).toBe(false)
  })

  it("refreshes csrf_invalid once and replays the same mutation exactly once", async () => {
    let csrfIssues = 0
    let mutationAttempts = 0
    const mutationBodies: BodyInit[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${API_BASE}/auth/csrf-token`) {
        csrfIssues += 1
        return jsonResponse(200, { csrfToken: csrfIssues === 1 ? "csrf-stale" : "csrf-fresh" })
      }
      mutationAttempts += 1
      mutationBodies.push(init?.body as BodyInit)
      if (mutationAttempts === 1) return jsonResponse(403, { error: "csrf_invalid" })
      return jsonResponse(200, { ok: true })
    })
    const authenticatedFetch = createAuthenticatedFetch({
      apiBaseUrl: API_BASE,
      fetchImpl: fetchImpl as typeof fetch,
      getBearerToken: () => null,
      readCsrfCookie: () => null,
    })

    const response = await authenticatedFetch(`${API_BASE}/ai/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "same payload" }),
    })

    expect(response.ok).toBe(true)
    expect(csrfIssues).toBe(2)
    expect(mutationAttempts).toBe(2)
    expect(mutationBodies).toEqual([
      JSON.stringify({ prompt: "same payload" }),
      JSON.stringify({ prompt: "same payload" }),
    ])
    const firstMutation = fetchImpl.mock.calls[1][1]
    const retriedMutation = fetchImpl.mock.calls[3][1]
    expect(new Headers(firstMutation?.headers).get("X-CSRF-Token")).toBe("csrf-stale")
    expect(new Headers(retriedMutation?.headers).get("X-CSRF-Token")).toBe("csrf-fresh")
  })

  it("stops after one csrf_invalid refresh", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${API_BASE}/auth/csrf-token`) {
        return jsonResponse(200, { csrfToken: `csrf-${fetchImpl.mock.calls.length}` })
      }
      return jsonResponse(403, { error: "csrf_invalid" })
    })
    const authenticatedFetch = createAuthenticatedFetch({
      apiBaseUrl: API_BASE,
      fetchImpl: fetchImpl as typeof fetch,
      getBearerToken: () => null,
      readCsrfCookie: () => null,
    })

    const response = await authenticatedFetch(`${API_BASE}/projects`, { method: "POST" })

    expect(response.status).toBe(403)
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === `${API_BASE}/projects`)).toHaveLength(2)
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/auth/csrf-token"))).toHaveLength(2)
  })

  it("never forwards bearer or CSRF headers to an external origin", async () => {
    localStorage.setItem("auth-token", "must-not-leak")
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const authenticatedFetch = createAuthenticatedFetch({ apiBaseUrl: API_BASE, fetchImpl })

    await authenticatedFetch("https://external.example/upload", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-secret",
        "X-CSRF-Token": "caller-csrf",
      },
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = fetchImpl.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(init.credentials).toBe("omit")
    expect(headers.has("Authorization")).toBe(false)
    expect(headers.has("X-CSRF-Token")).toBe(false)
  })
})
