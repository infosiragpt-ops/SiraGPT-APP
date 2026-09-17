import { beforeEach, describe, expect, it, vi } from "vitest"

import { projectsCodexApi } from "@/lib/codex/api/projects"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("codex chat↔project binding client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    })
  })

  it("getProjectByChat pide el proyecto vinculado y devuelve project", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url))
        return jsonResponse({ project: { id: "p1", name: "A" }, chatId: "chat-1" })
      }),
    )
    const project = await projectsCodexApi.getProjectByChat("chat-1")
    expect(project).toEqual({ id: "p1", name: "A" })
    expect(calls.some((url) => url.includes("/projects/by-chat/chat-1"))).toBe(true)
  })

  it("getProjectByChat propaga el 404 como project_not_found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "project_not_found" }, 404)),
    )
    await expect(projectsCodexApi.getProjectByChat("chat-9")).rejects.toMatchObject({
      status: 404,
    })
  })

  it("ensureProjectForChat crea con POST y devuelve reused", async () => {
    const seen: Array<{ url: string; init: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: unknown) => {
        seen.push({ url: String(url), init })
        return jsonResponse(
          { project: { id: "p9", name: "Mi app" }, reused: false, chatId: "chat-9" },
          201,
        )
      }),
    )
    const binding = await projectsCodexApi.ensureProjectForChat("chat-9", "Mi app")
    expect(binding.reused).toBe(false)
    expect(binding.project.id).toBe("p9")
    const post = seen.find((call) => (call.init as RequestInit)?.method === "POST")
    expect(post?.url).toContain("/projects/by-chat/chat-9")
    expect(JSON.parse(String((post?.init as RequestInit)?.body))).toEqual({ name: "Mi app" })
  })

  it("ensureProjectForChat omite el nombre cuando no se indica", async () => {
    let sentBody = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        sentBody = String((init as RequestInit)?.body ?? "")
        return jsonResponse({ project: { id: "p1", name: "Mi app web" }, reused: true, chatId: "c" })
      }),
    )
    await projectsCodexApi.ensureProjectForChat("c")
    expect(JSON.parse(sentBody)).toEqual({})
  })
})
