import { beforeEach, describe, expect, it, vi } from "vitest"
const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: transport }))
import { actComputerBrowser, readComputerBrowser, postComputerNavigate } from "@/lib/computer-navigate-client"
const browser = { tabs: [{ id: "tab-a", title: "Example", url: "https://example.com/" }], activeTabId: "tab-a", canGoBack: false, canGoForward: false, presentation: "embedded", viewport: { width: 800, height: 600 } }
const envelope = (chat = "qa") => ({ ok: true, sessionId: "owned-session", conversationId: chat || null, conversationBound: Boolean(chat), browser })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => transport.mockReset())
describe("browser controls use confirmed existing sessions", () => {
  it.each(["qa", ""])("reads %s without creating a session and preserves abort plus deadline", async (chat) => {
    const controller = new AbortController()
    transport.mockResolvedValue(json(envelope(chat)))
    expect(await readComputerBrowser(chat, "owned-session", controller.signal)).toEqual(browser)
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, init] = transport.mock.calls[0]
    const query = new URL(url, "https://siragpt.com").searchParams
    expect(query.get("sessionId")).toBe("owned-session")
    expect(query.get("conversationId")).toBe(chat || null)
    expect(init.signal).not.toBe(controller.signal)
    controller.abort()
    expect(init.signal.aborted).toBe(true)
  })
  it.each([
    { sessionId: "other-session" }, { conversationId: "other-chat" }, { conversationId: null, conversationBound: false },
    { ok: false }, { browser: { ...browser, activeTabId: "missing" } }, { browser: { ...browser, tabs: [browser.tabs[0], browser.tabs[0]] } },
    { browser: { ...browser, viewport: { width: "800", height: 600 } } },
  ])("rejects incorrect ownership or malformed state %j", async (patch) => {
    transport.mockResolvedValue(json({ ...envelope(), ...patch }))
    await expect(readComputerBrowser("qa", "owned-session")).rejects.toThrow("No se pudo confirmar")
  })
  it("home never accepts a conversation-bound response", async () => {
    transport.mockResolvedValue(json(envelope("other-chat")))
    await expect(readComputerBrowser("", "owned-session")).rejects.toThrow("No se pudo confirmar")
  })
  it("sends the exact selected tab and size to the owned session", async () => {
    transport.mockResolvedValue(json(envelope()))
    const action = { type: "browser_resize" as const, width: 390, height: 600 }
    await actComputerBrowser("qa", "owned-session", action)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ sessionId: "owned-session", conversationId: "qa", action })
  })
  it.each([502, 200])("keeps raw provider details out of errors for HTTP%s", async (status) => {
    transport.mockResolvedValue(json({ ok: false, message: "Bearer SECRET https://private/?token=SECRET" }, status))
    await expect(actComputerBrowser("qa", "owned-session", { type: "browser_back" })).rejects.toThrow(/^No se pudo/)
    try { await readComputerBrowser("qa", "owned-session") } catch (error) { expect(String(error)).not.toMatch(/SECRET|Bearer|private/) }
  })
  it.each(["qa", ""])("navigates an existing %s session without reacquisition", async (chat) => {
    transport.mockResolvedValue(json({ ...envelope(chat), url: "https://example.com/final" }))
    expect(await postComputerNavigate(chat, "https://example.com", "tab-a", "owned-session")).toBe("https://example.com/final")
    expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ url: "https://example.com/", tabId: "tab-a", sessionId: "owned-session", ...(chat ? { conversationId: chat } : {}) })
  })
  it("does not acknowledge navigation in a different session", async () => {
    transport.mockResolvedValue(json({ ...envelope(), sessionId: "other", url: "https://example.com/" }))
    await expect(postComputerNavigate("qa", "https://example.com", "tab-a", "owned-session")).rejects.toThrow("esta computadora")
  })
})
