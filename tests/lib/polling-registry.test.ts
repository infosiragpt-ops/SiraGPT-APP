import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createPollingRegistry, type PollingTimer } from "@/lib/polling-registry"

const timer = (id: number) => id as unknown as PollingTimer

describe("polling registry", () => {
  it("keeps sibling operations alive when another operation is registered or cleared", () => {
    const clearTimer = vi.fn()
    const registry = createPollingRegistry(clearTimer)
    const first = timer(1)
    const second = timer(2)

    registry.register("video-1", first)
    registry.register("thesis-1", second)

    expect(registry.size()).toBe(2)
    expect(clearTimer).not.toHaveBeenCalled()

    registry.clear("video-1")
    expect(clearTimer).toHaveBeenCalledOnce()
    expect(clearTimer).toHaveBeenCalledWith(first)
    expect(registry.has("video-1")).toBe(false)
    expect(registry.get("thesis-1")).toBe(second)
  })

  it("clears only a superseded timer for the same operation id", () => {
    const clearTimer = vi.fn()
    const registry = createPollingRegistry(clearTimer)
    const oldTimer = timer(1)
    const replacement = timer(2)

    registry.register("video-1", oldTimer)
    registry.register("video-1", replacement)

    expect(clearTimer).toHaveBeenCalledOnce()
    expect(clearTimer).toHaveBeenCalledWith(oldTimer)
    expect(registry.get("video-1")).toBe(replacement)
  })

  it("clears every registered timer exactly once on teardown", () => {
    const clearTimer = vi.fn()
    const registry = createPollingRegistry(clearTimer)
    registry.register("video-1", timer(1))
    registry.register("video-2", timer(2))

    registry.clearAll()

    expect(clearTimer).toHaveBeenCalledTimes(2)
    expect(registry.size()).toBe(0)
  })

  it("is wired into ChatProvider without state-dependent cleanup", () => {
    const source = readFileSync(join(process.cwd(), "lib/chat-context-integrated.tsx"), "utf8")

    expect(source.match(/startSerializedPreviewPoll</g)).toHaveLength(2)
    expect(source).toContain("pollingRegistry.register(operationId, timer)")
    expect(source).toContain("pollingRegistry.register(sessionId, timer)")
    expect(source).not.toContain("setInterval(async () =>")
    expect(source).toContain("pollingRegistry.clearAll()")
    expect(source).not.toContain("setPollingIntervals")
    expect(source).not.toContain("[pollingIntervals]")
  })
})
