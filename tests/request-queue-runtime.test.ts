import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  RequestQueue,
  RequestQueueCancelledError,
  RequestQueueTimeoutError,
} from "../lib/request-queue"

describe("RequestQueue runtime behavior", () => {
  test("offline enqueue promise resolves when flush replays the request", async () => {
    const queue = new RequestQueue({ initialOnline: false, replayTimeoutMs: 100 })
    const events: string[] = []
    queue.subscribe((items) => events.push(items.map((item) => item.status).join(",")))

    const promise = queue.enqueue(async (ctx) => {
      assert.equal(ctx?.phase, "replay")
      assert.ok(ctx?.signal instanceof AbortSignal)
      return new Response("ok")
    }, "offline-ok")

    assert.equal(queue.length, 1)
    queue.setOnline(true, { flush: false })
    await queue.flush()

    const response = await promise
    assert.equal(await response.text(), "ok")
    assert.equal(queue.items[0]?.status, "done")
    assert.ok(events.some((status) => status.includes("queued")))
    assert.ok(events.some((status) => status.includes("replaying")))
  })

  test("failed replay rejects only that request and continues with later items", async () => {
    const queue = new RequestQueue({ initialOnline: false, replayTimeoutMs: 100 })
    const first = queue.enqueue(async () => {
      throw new Error("boom")
    }, "first").catch((error) => error)
    const second = queue.enqueue(async () => new Response("second"), "second")

    queue.setOnline(true, { flush: false })
    await queue.flush()

    const firstError = await first
    const secondResponse = await second
    assert.equal(firstError.message, "boom")
    assert.equal(await secondResponse.text(), "second")
    assert.deepEqual(queue.items.map((item) => item.status), ["failed", "done"])
  })

  test("hung replay times out, aborts the signal, and rejects the enqueue promise", async () => {
    const queue = new RequestQueue({ initialOnline: false, replayTimeoutMs: 10 })
    let capturedSignal: AbortSignal | undefined
    const promise = queue.enqueue(async (ctx) => {
      capturedSignal = ctx?.signal
      return new Promise<Response>(() => undefined)
    }, "hung").catch((error) => error)

    queue.setOnline(true, { flush: false })
    await queue.flush()

    const error = await promise
    assert.ok(error instanceof RequestQueueTimeoutError)
    assert.equal(error.timeoutMs, 10)
    assert.equal(capturedSignal?.aborted, true)
    assert.equal(queue.items[0]?.status, "failed")
    assert.match(queue.items[0]?.lastError ?? "", /timed out/)
  })

  test("hung immediate execution also times out and rejects the caller", async () => {
    const queue = new RequestQueue({ initialOnline: true, replayTimeoutMs: 10 })
    let capturedSignal: AbortSignal | undefined
    const error = await queue.enqueue(async (ctx) => {
      capturedSignal = ctx?.signal
      assert.equal(ctx?.phase, "immediate")
      return new Promise<Response>(() => undefined)
    }, "immediate-hung").catch((err) => err)

    assert.ok(error instanceof RequestQueueTimeoutError)
    assert.equal(error.timeoutMs, 10)
    assert.equal(capturedSignal?.aborted, true)
  })

  test("cancelAll rejects queued promises instead of leaving them pending", async () => {
    const queue = new RequestQueue({ initialOnline: false })
    const promise = queue.enqueue(async () => new Response("never"), "cancel-me").catch((error) => error)

    queue.cancelAll()

    const error = await promise
    assert.ok(error instanceof RequestQueueCancelledError)
    assert.equal(queue.items[0]?.status, "failed")
    assert.match(queue.items[0]?.lastError ?? "", /cancelled/)
  })
})
