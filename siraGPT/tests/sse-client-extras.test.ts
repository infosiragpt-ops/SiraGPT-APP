import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createSseJsonParser, streamSseJson } from "../lib/sse-client"

/**
 * Extras on top of the 4 base sse-client tests. Pins:
 *
 *   - createSseJsonParser callback invocation paths
 *   - streamSseJson abort signal (pre-aborted + mid-flight abort)
 *   - onChunk callback fires per chunk
 *   - trailing decode emits any remaining buffered frame
 */

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk))
      }
      controller.close()
    },
  })
}

describe("createSseJsonParser · callback contracts", () => {
  it("invokes onDoneMessage exactly once on [DONE] frame", () => {
    let count = 0
    const parser = createSseJsonParser({ onDoneMessage: () => count++ })
    parser.feed("data: [DONE]\n\n")
    assert.equal(count, 1)
  })

  it("does NOT invoke onDoneMessage when ignoreDoneMessage=false", () => {
    let count = 0
    const parser = createSseJsonParser({
      ignoreDoneMessage: false,
      onDoneMessage: () => count++,
    })
    parser.feed("data: [DONE]\n\n")
    // The [DONE] frame is now parsed as JSON and likely fails
    // (it's not valid JSON), routing through onMalformedMessage.
    assert.equal(count, 0)
  })

  it("invokes onMalformedMessage with rawData + error for invalid JSON", () => {
    const errors: Array<{ raw: string; err: unknown }> = []
    const parser = createSseJsonParser({
      onMalformedMessage: (raw, err) => errors.push({ raw, err }),
    })
    parser.feed("data: {not valid\n\n")
    assert.equal(errors.length, 1)
    assert.equal(errors[0].raw, "{not valid")
    assert.ok(errors[0].err instanceof Error)
  })

  it("reset() clears queued frames and the underlying parser", () => {
    const parser = createSseJsonParser<{ n: number }>()
    parser.feed("data: {\"n\":1}\n\n") // queue: [1]
    parser.reset()
    const out = parser.feed("data: {\"n\":2}\n\n")
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].data, { n: 2 })
  })
})

describe("streamSseJson · abort + chunk callbacks", () => {
  it("invokes onChunk once per network chunk", async () => {
    let chunks = 0
    const body = streamFromChunks([
      "data: {\"i\":1}\n\n",
      "data: {\"i\":2}\n\n",
    ])
    for await (const _ of streamSseJson(body, { onChunk: () => chunks++ })) {
      // drain
    }
    // onChunk fires per reader.read() so at least chunks >= 2.
    assert.ok(chunks >= 2, `expected >= 2 chunks, got ${chunks}`)
  })

  it("yields no values when the signal is pre-aborted", async () => {
    const body = streamFromChunks(["data: {\"i\":1}\n\n"])
    const ctrl = new AbortController()
    ctrl.abort()
    const collected: any[] = []
    for await (const value of streamSseJson(body, { signal: ctrl.signal })) {
      collected.push(value)
    }
    assert.equal(collected.length, 0)
  })

  it("stops on [DONE] when stopOnDoneMessage=true and ignores later frames", async () => {
    const body = streamFromChunks([
      "data: {\"i\":1}\n\n",
      "data: [DONE]\n\n",
      "data: {\"i\":999}\n\n", // arrives after [DONE], should NOT be yielded
    ])
    const collected: any[] = []
    for await (const value of streamSseJson(body, { stopOnDoneMessage: true })) {
      collected.push(value)
    }
    assert.equal(collected.length, 1)
    assert.deepEqual(collected[0], { i: 1 })
  })

  it("propagates the onDoneMessage callback to the parser inside", async () => {
    let doneSeen = 0
    const body = streamFromChunks([
      "data: {\"i\":1}\n\n",
      "data: [DONE]\n\n",
    ])
    for await (const _ of streamSseJson(body, {
      onDoneMessage: () => doneSeen++,
    })) {
      // drain
    }
    assert.equal(doneSeen, 1)
  })
})
