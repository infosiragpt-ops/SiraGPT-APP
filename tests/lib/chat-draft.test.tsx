import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearAllChatDrafts, useChatDraft } from "@/hooks/use-chat-draft"

describe("useChatDraft", () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    window.localStorage.clear()
  })

  it("persists and restores a draft before the first chat exists", () => {
    const first = renderHook(() => useChatDraft(null, "user-a"))

    act(() => {
      first.result.current.save("primer prompt importante")
      vi.advanceTimersByTime(350)
    })

    expect(window.localStorage.getItem("sira:chat-draft:user-a:__new__"))
      .toBe("primer prompt importante")

    first.unmount()
    const restored = renderHook(() => useChatDraft(undefined, "user-a"))
    expect(restored.result.current.loadInitial()).toBe("primer prompt importante")
  })

  it("keeps the new-chat draft isolated per account and clears it on send", () => {
    const accountA = renderHook(() => useChatDraft(null, "user-a"))
    const accountB = renderHook(() => useChatDraft(null, "user-b"))

    act(() => {
      accountA.result.current.save("solo A")
      accountB.result.current.save("solo B")
      vi.advanceTimersByTime(350)
    })

    expect(accountA.result.current.loadInitial()).toBe("solo A")
    expect(accountB.result.current.loadInitial()).toBe("solo B")

    act(() => accountA.result.current.clear())
    expect(accountA.result.current.loadInitial()).toBeNull()
    expect(accountB.result.current.loadInitial()).toBe("solo B")

    clearAllChatDrafts()
    expect(accountB.result.current.loadInitial()).toBeNull()
  })

  it("flushes a pending write into the chat scope captured at save time", () => {
    const hook = renderHook(
      ({ chatId }) => useChatDraft(chatId, "user-a"),
      { initialProps: { chatId: "chat-a" as string | null } },
    )

    act(() => hook.result.current.save("borrador de A"))
    hook.rerender({ chatId: "chat-b" })
    act(() => vi.advanceTimersByTime(350))

    expect(window.localStorage.getItem("sira:chat-draft:user-a:chat-a")).toBe("borrador de A")
    expect(window.localStorage.getItem("sira:chat-draft:user-a:chat-b")).toBeNull()
  })
})
