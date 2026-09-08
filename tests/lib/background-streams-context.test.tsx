import React from "react"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  BackgroundStreamsProvider,
  useBackgroundStreams,
} from "@/lib/background-streams-context"

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <BackgroundStreamsProvider>{children}</BackgroundStreamsProvider>
)

afterEach(() => cleanup())

describe("BackgroundStreamsProvider", () => {
  it("publishes immutable status transitions for concurrent chats", () => {
    const { result } = renderHook(() => useBackgroundStreams(), { wrapper })
    const firstController = new AbortController()
    const secondController = new AbortController()

    act(() => {
      result.current.register("chat-1", "Primero", firstController)
      result.current.register("chat-2", "Segundo", secondController)
    })
    expect(result.current.activeCount).toBe(2)

    const streamingSnapshot = result.current.streams
    const firstStream = streamingSnapshot.get("chat-1")
    act(() => result.current.complete("chat-1"))

    expect(result.current.streams).not.toBe(streamingSnapshot)
    expect(result.current.streams.get("chat-1")).not.toBe(firstStream)
    expect(result.current.get("chat-1")?.status).toBe("done")
    expect(result.current.activeCount).toBe(1)

    act(() => result.current.fail("chat-2", "provider failed"))
    expect(result.current.get("chat-2")).toMatchObject({
      status: "error",
      error: "provider failed",
    })
    expect(result.current.activeCount).toBe(0)
  })

  it("keeps partial content authoritative while replacing map snapshots", () => {
    const { result } = renderHook(() => useBackgroundStreams(), { wrapper })
    act(() => result.current.register("chat-1", "Chat", new AbortController()))
    const beforeAppend = result.current.streams
    const beforeStream = result.current.get("chat-1")

    act(() => {
      result.current.appendChunk("chat-1", "hola ")
      result.current.appendChunk("chat-1", "mundo")
    })

    expect(result.current.get("chat-1")?.partialContent).toBe("hola mundo")
    expect(result.current.streams).not.toBe(beforeAppend)
    expect(result.current.get("chat-1")).not.toBe(beforeStream)
  })

  it("cancels only the requested chat", () => {
    const { result } = renderHook(() => useBackgroundStreams(), { wrapper })
    const firstController = new AbortController()
    const secondController = new AbortController()
    act(() => {
      result.current.register("chat-1", "Primero", firstController)
      result.current.register("chat-2", "Segundo", secondController)
      result.current.cancel("chat-1")
    })

    expect(firstController.signal.aborted).toBe(true)
    expect(secondController.signal.aborted).toBe(false)
    expect(result.current.get("chat-1")).toBeUndefined()
    expect(result.current.get("chat-2")?.status).toBe("streaming")
    expect(result.current.activeCount).toBe(1)
  })
})
