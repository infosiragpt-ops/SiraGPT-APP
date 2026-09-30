import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ getMemory: vi.fn() }))
vi.mock("@/lib/api", () => ({ apiClient: api }))

import { _resetMemoryStatusForTests, refreshMemoryStatus, setMemoryStatusCount, useMemoryStatus } from "@/lib/chat/use-memory-status"

beforeEach(() => {
  api.getMemory.mockReset()
  _resetMemoryStatusForTests()
})

describe("memory status (light-blue «Memoria activa» check)", () => {
  it("is active once the user's memory has entries, fetched once and shared", async () => {
    api.getMemory.mockResolvedValue({ entries: [{ id: "1" }, { id: "2" }], markdown: "", stats: { total: 2, byCategory: {} } })
    const a = renderHook(() => useMemoryStatus())
    const b = renderHook(() => useMemoryStatus())
    await waitFor(() => expect(a.result.current).toEqual({ active: true, count: 2, loaded: true }))
    expect(b.result.current).toEqual({ active: true, count: 2, loaded: true })
    expect(api.getMemory).toHaveBeenCalledTimes(1)
  })

  it("stays inactive with an empty memory and never throws when the API fails", async () => {
    api.getMemory.mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useMemoryStatus())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.active).toBe(false)
  })

  it("does nothing while disabled; Ajustes → Memoria can publish the count directly", async () => {
    api.getMemory.mockResolvedValue({ entries: [], markdown: "", stats: { total: 0, byCategory: {} } })
    const disabled = renderHook(() => useMemoryStatus(false))
    expect(api.getMemory).not.toHaveBeenCalled()
    expect(disabled.result.current.loaded).toBe(false)
    act(() => setMemoryStatusCount(3))
    const enabled = renderHook(() => useMemoryStatus())
    expect(enabled.result.current).toEqual({ active: true, count: 3, loaded: true })
    // Already loaded: mounting another subscriber never re-fetches.
    expect(api.getMemory).not.toHaveBeenCalled()
    await act(async () => { await refreshMemoryStatus() })
    await waitFor(() => expect(enabled.result.current).toEqual({ active: false, count: 0, loaded: true }))
  })
})
