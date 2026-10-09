import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), createChat: vi.fn(), addMessage: vi.fn(), prepare: vi.fn(async (request: any) => request) }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: (...args: any[]) => mocks.fetch(...args) }))
vi.mock("@/lib/api", () => ({ apiClient: { createChat: mocks.createChat, addMessage: mocks.addMessage, prepareMutatingFetch: mocks.prepare } }))
import { useResearchGoal } from "@/hooks/use-research-goal"
import { createResearchEventDecoder, findResearchGoalPointer, saveResearchGoalPointer } from "@/lib/chat/research-goal-client"

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const options = (chat: any = { id: "chat1", messages: [] }) => ({ ownerId: "owner1", chat, selectChat: vi.fn(async () => {}), refreshChat: vi.fn(async () => {}), markBusy: vi.fn(), markIdle: vi.fn(), notify: vi.fn(() => "toast1") })

describe("durable research goals", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    mocks.fetch.mockReset(); mocks.createChat.mockReset(); mocks.addMessage.mockReset()
    mocks.addMessage.mockResolvedValue({ message: { id: "user-msg1" } })
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })
  afterEach(() => { vi.useRealTimers() })

  it("recovers by owner and chat, uses persisted user metadata, and skips a completed report", () => {
    saveResearchGoalPointer({ ownerId: "owner1", chatId: "chat1", runId: "rr_one" })
    expect(findResearchGoalPointer("owner2", { id: "chat1" })).toBeNull()
    expect(findResearchGoalPointer("owner1", { id: "chat2" })).toBeNull()
    expect(findResearchGoalPointer("owner1", { id: "chat1" })?.runId).toBe("rr_one")
    localStorage.clear()
    const messages = [{ role: "USER", metadata: JSON.stringify({ researchRunId: "rr_two" }) }]
    expect(findResearchGoalPointer("owner1", { id: "chat1", messages })?.runId).toBe("rr_two")
    expect(findResearchGoalPointer("owner1", { id: "chat1", messages: [...messages, { role: "ASSISTANT", metadata: { researchRunId: "rr_two", research: {} } }] })).toBeNull()
  })

  it("decodes partial UTF-8, CRLF, malformed frames and an unterminated final frame", () => {
    const events: any[] = []
    const decoder = createResearchEventDecoder(event => events.push(event))
    const bytes = new TextEncoder().encode('data: {"label":"investigación"}\r\n\r\ndata: malformed\n\ndata: {"type":"report"}')
    for (let i = 0; i < bytes.length; i += 7) decoder.push(bytes.slice(i, i + 7))
    decoder.push(undefined, true)
    expect(events).toEqual([{ label: "investigación" }, { type: "report" }])
  })

  it("persists the query and respects model/provider; completion only refreshes the server's report", async () => {
    let payload: any
    mocks.fetch.mockImplementation(async (url: string, request: RequestInit) => {
      if (url.endsWith("/stream")) {
        payload = JSON.parse(String(request.body))
        return new Response('data: {"type":"report"}\n\n')
      }
      return json({ runId: payload.runId, chatId: "chat1", status: "completed", result: { stats: { papersFound: 3, findingsExtracted: 2 } } })
    })
    const opts = options()
    const hook = renderHook(() => useResearchGoal(opts))
    await act(async () => { expect(await hook.result.current.start({ query: "medical evidence", model: "gpt-5", provider: "OpenAI", chat: opts.chat })).toBe(true) })
    expect(payload).toMatchObject({ query: "medical evidence", chatId: "chat1", model: "gpt-5", provider: "OpenAI", userMessageId: "user-msg1" })
    expect(payload.runId).toMatch(/^rr_[-a-zA-Z0-9_]+$/)
    expect(mocks.addMessage).toHaveBeenCalledTimes(1)
    expect(mocks.addMessage.mock.calls[0][1]).toMatchObject({ role: "USER", metadata: { researchRunId: payload.runId } })
    expect(opts.refreshChat).toHaveBeenCalledWith("chat1")
    expect(opts.markIdle).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it("keeps Stop busy until the durable cancel acknowledgement, and does not cancel on unmount", async () => {
    let runId = ""
    let acknowledge!: (response: Response) => void
    mocks.fetch.mockImplementation(async (url: string, request: RequestInit) => {
      if (url.endsWith("/stream")) { runId = JSON.parse(String(request.body)).runId; return new Response('data: {"type":"start"}\n\n') }
      if (url.endsWith("/cancel")) return new Promise<Response>(resolve => { acknowledge = resolve })
      return json({ runId, chatId: "chat1", status: "running" })
    })
    const opts = options()
    const hook = renderHook(() => useResearchGoal(opts))
    await act(async () => { await hook.result.current.start({ query: "evidence", model: "deepseek-v4-flash", provider: "DeepSeek", chat: opts.chat }) })
    act(() => { expect(hook.result.current.stop("chat2")).toBe(false); expect(hook.result.current.stop("chat1")).toBe(true) })
    await act(async () => { await Promise.resolve() })
    expect(opts.markIdle).not.toHaveBeenCalled()
    await act(async () => { acknowledge(json({ runId, status: "cancelled" })); await Promise.resolve() })
    expect(opts.markIdle).toHaveBeenCalledTimes(1)
    hook.unmount()
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1)
  })

  it("recovers a running job after reload and disconnects without a cancellation request", async () => {
    saveResearchGoalPointer({ ownerId: "owner1", chatId: "chat1", runId: "rr_recovered" })
    mocks.fetch.mockResolvedValue(json({ runId: "rr_recovered", chatId: "chat1", status: "running" }))
    const opts = options()
    const hook = renderHook(() => useResearchGoal(opts))
    await act(async () => { await Promise.resolve() })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(opts.markBusy).toHaveBeenCalledTimes(1)
    hook.unmount()
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false)
    expect(findResearchGoalPointer("owner1", opts.chat)?.runId).toBe("rr_recovered")
  })
})
