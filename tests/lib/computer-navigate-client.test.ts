import { beforeEach, describe, expect, it, vi } from "vitest"

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: transport }))
import { postComputerNavigate } from "@/lib/computer-navigate-client"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { transport.mockReset() })

describe("confirmed computer navigation", () => {
  it("uses the loaded URL and never focuses a different browser window afterwards", async () => {
    transport.mockResolvedValueOnce(json({ sessionId: "bound-desktop" }))
      .mockResolvedValueOnce(json({ ok: true, url: "https://example.com/redirected" }))
      .mockResolvedValue(json({ ok: true }))
    expect(await postComputerNavigate("qa-chat", "https://example.com/")).toBe("https://example.com/redirected")
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[1][0]).toMatch(/agent-computer\/navigate$/)
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ url: "https://example.com/", conversationId: "qa-chat" })
  })

  it.each([
    [200, { ok: false, message: "No se pudo abrir la página." }],
    [502, { error: "navigate_failed", message: "No se pudo abrir la página." }],
    [200, {}],
    [200, null],
    [200, { ok: true }],
    [200, { ok: true, url: "javascript:alert(1)" }],
  ])("rejects status %s without a confirmed safe loaded URL", async (status, body) => {
    transport.mockResolvedValueOnce(json({ sessionId: "bound-desktop" }))
      .mockResolvedValueOnce(json(body, status)).mockResolvedValue(json({ ok: true }))
    await expect(postComputerNavigate("qa-chat", "https://example.com/")).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
