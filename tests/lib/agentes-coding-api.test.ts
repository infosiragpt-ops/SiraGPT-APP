import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  createAgentesCodingApi,
  parseHealthEnabled,
  shouldMountAgentesCodingIde,
  AgentesCodingApiError,
} from "@/lib/agentes-coding/api"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("agentes-coding API client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("treats only enabled:true as on; default and garbage stay off", () => {
    expect(parseHealthEnabled(undefined)).toBe(false)
    expect(parseHealthEnabled(null)).toBe(false)
    expect(parseHealthEnabled({ ok: true })).toBe(false)
    expect(parseHealthEnabled({ enabled: false })).toBe(false)
    expect(parseHealthEnabled({ enabled: "1" })).toBe(false)
    expect(parseHealthEnabled({ enabled: 1 })).toBe(false)
    expect(parseHealthEnabled({ enabled: true })).toBe(true)
    expect(shouldMountAgentesCodingIde({ enabled: true })).toBe(true)
    expect(shouldMountAgentesCodingIde({ enabled: false })).toBe(false)
    expect(shouldMountAgentesCodingIde(null)).toBe(false)
  })

  it("health() stays disabled when the probe fails or reports off", async () => {
    const off = createAgentesCodingApi({
      apiBase: "https://sira.test/api",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ ok: true, enabled: false })),
    })
    await expect(off.health()).resolves.toEqual({ ok: true, enabled: false })

    const fail = createAgentesCodingApi({
      apiBase: "https://sira.test/api",
      fetchImpl: vi.fn().mockRejectedValue(new Error("network")),
    })
    await expect(fail.health()).resolves.toEqual({ ok: true, enabled: false })
  })

  it("maps session 404 to E_FLAG_OFF with Spanish copy", async () => {
    const api = createAgentesCodingApi({
      apiBase: "https://sira.test/api",
      request: vi.fn().mockResolvedValue(jsonResponse({ error: "not_found" }, 404)) as any,
    })
    await expect(api.createSession()).rejects.toMatchObject({
      code: "E_FLAG_OFF",
      status: 404,
    })
    try {
      await api.createSession()
    } catch (err) {
      expect(err).toBeInstanceOf(AgentesCodingApiError)
      expect(String((err as Error).message)).toMatch(/no está activo/)
    }
  })

  it("createSession / listFiles / readFile / writeFile hit the flagged routes", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return jsonResponse({ ok: true, session: { id: "csb_1" } }, 201)
      }
      if (url.includes("/sessions/csb_1/files") && (!init?.method || init.method === "GET")) {
        return jsonResponse({ ok: true, files: [{ path: "a.ts", size: 2 }] })
      }
      if (url.endsWith("/sessions/csb_1/read")) {
        return jsonResponse({ ok: true, content: "export {}", path: "a.ts" })
      }
      if (url.endsWith("/sessions/csb_1/files") && init?.method === "PUT") {
        return jsonResponse({ ok: true, file: { path: "a.ts", bytes: 9 } })
      }
      if (url.includes("/sessions/csb_1/map")) {
        return jsonResponse({
          ok: true,
          hints: [{ name: "a.ts", path: "a.ts", kind: "file", score: 1 }],
        })
      }
      return jsonResponse({ error: "not_found" }, 404)
    })
    const api = createAgentesCodingApi({
      apiBase: "https://sira.test/api",
      request: request as any,
    })

    const session = await api.createSession()
    expect(session.id).toBe("csb_1")
    expect(await api.listFiles(session.id)).toEqual([{ path: "a.ts", size: 2 }])
    expect(await api.readFile(session.id, "a.ts")).toBe("export {}")
    expect(await api.writeFile(session.id, "a.ts", "export {}")).toEqual({ path: "a.ts", bytes: 9 })
    expect(await api.repoMap(session.id, { limit: 8 })).toEqual({
      ok: true,
      hints: [{ name: "a.ts", path: "a.ts", kind: "file", score: 1 }],
      omitted: undefined,
      scanned: undefined,
      headerBytes: undefined,
      query: undefined,
    })
    expect(String(request.mock.calls[0][0])).toBe("https://sira.test/api/agentes-coding/sessions")
    expect(String(request.mock.calls.at(-1)?.[0])).toContain("/sessions/csb_1/map?limit=8")
  })
})
