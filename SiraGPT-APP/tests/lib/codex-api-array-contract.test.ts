import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { codexApi } from "@/lib/codex/codex-api"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("Codex changing-list contracts", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("bypasses HTTP caches and normalizes missing list payloads", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ checkpoints: null }))

    await expect(codexApi.listRuns("project-1")).resolves.toEqual([])
    await expect(codexApi.listCheckpoints("project-1")).resolves.toEqual([])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]?.cache).toBe("no-store")
    expect(fetchMock.mock.calls[1][1]?.cache).toBe("no-store")
  })

  it("preserves valid arrays returned by the backend", async () => {
    const run = { id: "run-1" }
    const checkpoint = { id: "checkpoint-1" }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ checkpoints: [checkpoint] }))

    await expect(codexApi.listRuns("project-1")).resolves.toEqual([run])
    await expect(codexApi.listCheckpoints("project-1")).resolves.toEqual([checkpoint])
  })
})
