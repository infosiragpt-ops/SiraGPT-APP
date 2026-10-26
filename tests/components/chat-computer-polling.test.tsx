import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { transport, emitted } = vi.hoisted(() => ({ transport: vi.fn(), emitted: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: transport }))
vi.mock("@/lib/api-base-url", () => ({ getSameOriginApiBaseUrl: () => "/api" }))
vi.mock("@/components/code/agent-computer-shell", () => ({ AgentComputerShell: () => null }))
vi.mock("@/components/code/department-computer-pane", () => ({ DepartmentComputerPane: () => null }))
vi.mock("@/components/agentes/coding-preview-pane", () => ({ CodingPreviewPane: () => null }))
vi.mock("@/components/chat/integrated-browser-bar", () => ({ IntegratedBrowserBar: () => null }))
vi.mock("@/components/chat/computer-login-handoff-banner", () => ({ ComputerLoginHandoffBanner: () => null }))
vi.mock("@/lib/cowork-api", () => ({ coworkApi: {
  ensureWorkspace: vi.fn().mockResolvedValue({ workspace: { id: "cw" } }),
  listScheduledTasks: vi.fn().mockResolvedValue({ tasks: [] }),
} }))
vi.mock("@/lib/computer-login-handoff", () => ({
  LOGIN_HANDOFF_WINDOW_EVENT: "test-login-handoff",
  emitLoginHandoff: emitted,
  overlayLayoutContract: () => ({ fullScreen: false }),
}))

import ChatAgentComputerPanel from "@/components/chat/chat-agent-computer-panel"

const props = { conversationId: "browser-chat", initialDock: "browser" as const, onClose: () => {} }
const response = (body: unknown = {}) => ({ ok: true, json: async () => body })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function flush() { await act(async () => {}) }
let visibility: DocumentVisibilityState
function setVisibility(value: DocumentVisibilityState) {
  visibility = value
  act(() => document.dispatchEvent(new Event("visibilitychange")))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  transport.mockReset().mockImplementation(async () => response())
  emitted.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("chat computer auxiliary polling", () => {
  it("does no hidden work and refreshes immediately once visible without forcing a live probe", async () => {
    visibility = "hidden"
    render(<ChatAgentComputerPanel {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(transport).not.toHaveBeenCalled()
    setVisibility("visible")
    await flush()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      "/api/agent-computer/activity?conversationId=browser-chat",
      "/api/agent-computer/login-handoff?conversationId=browser-chat",
    ])
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(transport).toHaveBeenCalledTimes(4)
    setVisibility("hidden")
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it.each(["hide", "unmount", "conversation"])("aborts a pending activity read on %s and never starts its stale handoff probe", async (change) => {
    const pending = deferred<ReturnType<typeof response>>()
    transport.mockReturnValueOnce(pending.promise)
    const view = render(<ChatAgentComputerPanel {...props} />)
    await flush()
    const signal = transport.mock.calls[0][1].signal as AbortSignal
    if (change === "hide") setVisibility("hidden")
    else if (change === "unmount") view.unmount()
    else view.rerender(<ChatAgentComputerPanel {...props} conversationId="other-chat" />)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(response()); await pending.promise })
    expect(transport.mock.calls.some(([url]) => String(url).includes("login-handoff?conversationId=browser-chat"))).toBe(false)
  })

  it("ignores a late handoff response after hiding and resumes with a fresh read", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    transport.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise)
    render(<ChatAgentComputerPanel {...props} />)
    await flush()
    expect(transport).toHaveBeenCalledTimes(2)
    const signal = transport.mock.calls[1][1].signal as AbortSignal
    setVisibility("hidden")
    expect(signal.aborted).toBe(true)
    setVisibility("visible")
    await flush()
    expect(transport).toHaveBeenCalledTimes(4)
    await act(async () => { pending.resolve(response({ active: true, site: "stale.example" })); await pending.promise })
    expect(emitted).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(transport).toHaveBeenCalledTimes(6)
  })

  it("does not overlap slow reads and retains confirmed login handoff delivery", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    transport.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response({ active: true, site: "example.com", kind: "login" }))
    render(<ChatAgentComputerPanel {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(transport).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(response()); await pending.promise })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ active: true, conversationId: "browser-chat", site: "example.com" }))
  })
})
