import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createGenerateStreamStallError,
  isGenerateStreamStall,
  readWithIdle,
  withTimeout,
} from "../lib/sse-idle"

describe("generate SSE idle watchdog", () => {
  it("classifies stall and connect timeout errors", () => {
    assert.equal(isGenerateStreamStall(createGenerateStreamStallError("idle")), true)
    assert.equal(isGenerateStreamStall(createGenerateStreamStallError("connect")), true)
    assert.equal(isGenerateStreamStall({ message: "Failed to fetch" }), false)
  })

  it("readWithIdle resolves when the chunk arrives before idle", async () => {
    const value = await readWithIdle(async () => ({ done: false, value: 1 }), { idleMs: 200 })
    assert.equal(value.value, 1)
  })

  it("readWithIdle rejects when the socket never yields a chunk", async () => {
    await assert.rejects(
      () => readWithIdle(() => new Promise(() => {}), { idleMs: 20 }),
      (err: any) => err?.code === "stream_stall",
    )
  })

  it("withTimeout does not abort a fast connect", async () => {
    const out = await withTimeout(async () => "ok", {
      ms: 200,
      createError: () => createGenerateStreamStallError("connect"),
    })
    assert.equal(out, "ok")
  })
})
