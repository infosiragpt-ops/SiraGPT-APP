import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createSseJsonParser, streamSseJson } from "../lib/sse-client"

function readableFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

describe("sse-client", () => {
  it("parses JSON SSE frames split across network chunks", () => {
    const parser = createSseJsonParser<{ type: string; value?: number }>()

    assert.deepEqual(parser.feed('data: {"typ'), [])
    const events = parser.feed('e":"progress","value":42}\n\n')

    assert.deepEqual(events.map(event => event.data), [{ type: "progress", value: 42 }])
  })

  it("supports comments and multiline data frames", () => {
    const parser = createSseJsonParser<{ type: string; chars: number }>()

    const events = parser.feed([
      ": heartbeat",
      "event: progress",
      "id: evt-1",
      "data: {",
      'data: "type": "progress",',
      'data: "chars": 128',
      "data: }",
      "",
      "",
    ].join("\n"))

    assert.equal(events.length, 1)
    assert.equal(events[0].event, "progress")
    assert.equal(events[0].id, "evt-1")
    assert.deepEqual(events[0].data, { type: "progress", chars: 128 })
  })

  it("skips malformed JSON frames without dropping later valid events", () => {
    const malformed: string[] = []
    const parser = createSseJsonParser<{ ok: boolean }>({
      onMalformedMessage(raw) {
        malformed.push(raw)
      },
    })

    const events = parser.feed('data: not-json\n\ndata: {"ok":true}\n\n')

    assert.deepEqual(malformed, ["not-json"])
    assert.deepEqual(events.map(event => event.data), [{ ok: true }])
  })

  it("can stop async stream consumption on [DONE]", async () => {
    const received: Array<{ content: string }> = []
    let sawDone = false

    for await (const event of streamSseJson<{ content: string }>(readableFromChunks([
      'data: {"content":"first"}\n\n',
      "data: [DONE]\n\n",
      'data: {"content":"after-done"}\n\n',
    ]), {
      stopOnDoneMessage: true,
      onDoneMessage() {
        sawDone = true
      },
    })) {
      received.push(event)
    }

    assert.equal(sawDone, true)
    assert.deepEqual(received, [{ content: "first" }])
  })
})
