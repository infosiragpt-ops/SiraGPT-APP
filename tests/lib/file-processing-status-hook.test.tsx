import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({
  authenticatedFetch: (...args: unknown[]) => transport.fetch(...args),
}))

import {
  resetFileProcessingStatusMemo,
  useFileProcessingStatus,
} from "@/hooks/use-file-processing-status"

function statusResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const indexing = (fileId: string) => statusResponse({ fileId, stage: "indexing", error: null, stageAt: null, isTerminal: false })
const ready = (fileId: string) => statusResponse({ fileId, stage: "ready", error: null, stageAt: "2026-10-08T10:00:00Z", isTerminal: true })

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  document.dispatchEvent(new Event("visibilitychange"))
}

/**
 * Every chip showing a file owned its own 2 s poll, a chat re-render remounted
 * them (a fresh poll even for a file the server had already called ready), and
 * a hidden tab kept polling. One shared request per file and tick, a 10 min
 * terminal memo, and a pause while the tab is hidden.
 */
describe("useFileProcessingStatus · shared polling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFileProcessingStatusMemo()
    transport.fetch.mockReset()
    setVisibility("visible")
  })
  afterEach(() => {
    vi.useRealTimers()
    resetFileProcessingStatusMemo()
  })

  it("several chips for the same file share one request per tick", async () => {
    transport.fetch.mockImplementation(async () => indexing("f1"))
    const a = renderHook(() => useFileProcessingStatus("f1"))
    const b = renderHook(() => useFileProcessingStatus("f1"))
    const c = renderHook(() => useFileProcessingStatus("f1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    expect(a.result.current.stage).toBe("indexing")
    expect(b.result.current.stage).toBe("indexing")
    expect(c.result.current.stage).toBe("indexing")

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(transport.fetch).toHaveBeenCalledTimes(2)
    a.unmount(); b.unmount(); c.unmount()
  })

  it("a terminal answer is reused across remounts without a request; a running one is not", async () => {
    transport.fetch.mockImplementation(async () => ready("f2"))
    const first = renderHook(() => useFileProcessingStatus("f2"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(first.result.current).toMatchObject({ stage: "ready", isTerminal: true, loading: false })
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = renderHook(() => useFileProcessingStatus("f2"))
    expect(second.result.current).toMatchObject({ fileId: "f2", stage: "ready", isTerminal: true, pending: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    second.unmount()

    transport.fetch.mockImplementation(async () => indexing("f3"))
    const running = renderHook(() => useFileProcessingStatus("f3"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    running.unmount()
    const again = renderHook(() => useFileProcessingStatus("f3"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(transport.fetch).toHaveBeenCalledTimes(3)
    expect(again.result.current.stage).toBe("indexing")
    again.unmount()
  })

  it("pauses while the tab is hidden and resumes on visibilitychange", async () => {
    transport.fetch.mockImplementation(async () => indexing("f4"))
    const { result, unmount } = renderHook(() => useFileProcessingStatus("f4"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(transport.fetch).toHaveBeenCalledTimes(1)

    act(() => setVisibility("hidden"))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    // The tick that was already scheduled ran, found the tab hidden and parked.
    expect(transport.fetch).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(transport.fetch).toHaveBeenCalledTimes(2)

    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0) })
    expect(transport.fetch).toHaveBeenCalledTimes(3)
    expect(result.current.stage).toBe("indexing")
    unmount()
  })

  it("give-up states are not cached: a 401 today does not hide a ready file after re-login", async () => {
    transport.fetch.mockImplementation(async () => statusResponse({ error: "unauthorized" }, 401))
    const denied = renderHook(() => useFileProcessingStatus("f5"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(denied.result.current.isTerminal).toBe(true)
    denied.unmount()

    transport.fetch.mockImplementation(async () => ready("f5"))
    const relogged = renderHook(() => useFileProcessingStatus("f5"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(transport.fetch).toHaveBeenCalledTimes(2)
    expect(relogged.result.current.stage).toBe("ready")
    relogged.unmount()
  })

  it("a blocked localStorage never breaks the poll", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("blocked", "SecurityError") },
    })
    try {
      transport.fetch.mockImplementation(async () => ready("f6"))
      const { result, unmount } = renderHook(() => useFileProcessingStatus("f6"))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.stage).toBe("ready")
      const [, init] = transport.fetch.mock.calls[0] as [unknown, RequestInit]
      expect(new Headers(init.headers).has("Authorization")).toBe(false)
      unmount()
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original)
    }
  })
})
