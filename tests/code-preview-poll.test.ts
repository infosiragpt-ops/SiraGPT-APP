import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { startSerializedPreviewPoll } from "../lib/code-preview-poll"

describe("serialized preview readiness poll", () => {

  it("progresses to ready with a slow status source and max concurrency one", async () => {
    let calls = 0
    let concurrent = 0
    let maxConcurrent = 0
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const controller = startSerializedPreviewPoll({
      read: async () => {
        calls += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 20))
        concurrent -= 1
        return { ready: calls >= 2 }
      },
      // The status read is intentionally much slower than the poll interval.
      intervalMs: 1,
      isCurrent: () => true,
      onValue: (status) => {
        if (!status.ready) return true
        resolveReady()
        return false
      },
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer),
    })

    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("poll timed out")), 500)),
    ])
    controller.stop()

    assert.equal(calls, 2)
    assert.equal(maxConcurrent, 1)
  })

  it("retries a transient status rejection without overlap or an unhandled rejection", async () => {
    let calls = 0
    let concurrent = 0
    let maxConcurrent = 0
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const unhandled: unknown[] = []
    const recordUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on("unhandledRejection", recordUnhandled)

    const controller = startSerializedPreviewPoll({
      read: async () => {
        calls += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 10))
        concurrent -= 1
        if (calls === 1) throw new Error("temporary network failure")
        return { ready: true }
      },
      intervalMs: 1,
      isCurrent: () => true,
      onValue: (status) => {
        if (!status.ready) return true
        resolveReady()
        return false
      },
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer),
    })

    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("poll timed out")), 500)),
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      controller.stop()
      process.off("unhandledRejection", recordUnhandled)
    }

    assert.equal(calls, 2)
    assert.equal(maxConcurrent, 1)
    assert.deepEqual(unhandled, [])
  })

  it("aborts an in-flight status read at the absolute readiness deadline", async () => {
    let reads = 0
    let aborted = false
    let deadlineCalls = 0
    let resolveDeadline!: () => void
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve })

    const controller = startSerializedPreviewPoll({
      read: (signal) => new Promise<{ ready: boolean }>((_resolve, reject) => {
        reads += 1
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("status read aborted"))
        }, { once: true })
      }),
      intervalMs: 0,
      isCurrent: () => true,
      onValue: () => { throw new Error("a hung read must never produce a value") },
      onError: () => { throw new Error("deadline cancellation is not a transient read error") },
      deadlineAtMs: Date.now() + 25,
      onDeadline: () => {
        deadlineCalls += 1
        resolveDeadline()
      },
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer),
    })

    await Promise.race([
      deadline,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline did not fire")), 500)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 15))
    controller.stop()

    assert.equal(reads, 1)
    assert.equal(aborted, true)
    assert.equal(deadlineCalls, 1)
  })

  it("terminates a rejected-read path when its absolute deadline has elapsed", async () => {
    let clock = 0
    let reads = 0
    let transientErrors = 0
    let deadlineCalls = 0
    let resolveDeadline!: () => void
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve })

    const controller = startSerializedPreviewPoll({
      read: async () => {
        reads += 1
        clock = 201
        throw new Error("temporary network failure")
      },
      intervalMs: 1,
      isCurrent: () => true,
      onValue: () => { throw new Error("a rejected read must never produce a value") },
      onError: () => {
        transientErrors += 1
        return true
      },
      deadlineAtMs: 200,
      now: () => clock,
      onDeadline: () => {
        deadlineCalls += 1
        resolveDeadline()
      },
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer),
    })

    await Promise.race([
      deadline,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline did not fire")), 500)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 15))
    controller.stop()

    assert.equal(reads, 1)
    assert.equal(transientErrors, 0, "an elapsed deadline must win over retry handling")
    assert.equal(deadlineCalls, 1)
  })

  it("waits for async terminal handling and leaves no follow-up timer armed", async () => {
    let scheduled = 0
    let activeTimers = 0
    let reads = 0
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })

    const controller = startSerializedPreviewPoll({
      read: async () => {
        reads += 1
        return { status: "completed" }
      },
      intervalMs: 1,
      isCurrent: () => true,
      onValue: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        resolveTerminal()
        return false
      },
      schedule: (callback, delayMs) => {
        scheduled += 1
        activeTimers += 1
        return setTimeout(() => {
          activeTimers -= 1
          callback()
        }, delayMs)
      },
      clear: (timer) => {
        clearTimeout(timer)
        activeTimers = Math.max(0, activeTimers - 1)
      },
    })

    await Promise.race([
      terminal,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("terminal poll timed out")), 500)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.stop()

    assert.equal(reads, 1)
    assert.equal(scheduled, 1, "a terminal value must not queue another read")
    assert.equal(activeTimers, 0)
  })

  it("does not patch state or re-arm after ownership is cleared during an in-flight read", async () => {
    let current = true
    let schedules = 0
    let values = 0
    let resolveRead!: (value: { status: string }) => void
    const read = new Promise<{ status: string }>((resolve) => { resolveRead = resolve })

    startSerializedPreviewPoll({
      read: () => read,
      intervalMs: 1,
      isCurrent: () => current,
      onValue: () => { values += 1 },
      schedule: (callback, delayMs) => {
        schedules += 1
        return setTimeout(callback, delayMs)
      },
      clear: (timer) => clearTimeout(timer),
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    current = false // provider unmounted / registry ownership cleared
    resolveRead({ status: "running" })
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(values, 0, "a stale in-flight result must not touch state")
    assert.equal(schedules, 1, "a stale in-flight result must not arm another timer")
  })
})
