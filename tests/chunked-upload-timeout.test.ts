import assert from "node:assert/strict"
import { describe, it } from "node:test"

import apiClient from "../lib/api"

type TestClient = {
  authenticatedFetch: (url: string, init?: RequestInit) => Promise<Response>
  uploadFileChunked: (file: File, opts?: Record<string, unknown>) => Promise<{ files?: unknown[] }>
}

const useTestClient = () => {
  const client = apiClient as unknown as TestClient
  const original = client.authenticatedFetch
  return {
    client,
    restore: () => {
      client.authenticatedFetch = original
    },
  }
}

const okJson = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response

describe("chunked upload per-chunk timeout", () => {
  it("retries a hung chunk PUT instead of hanging forever", async () => {
    const { client, restore } = useTestClient()
    const calls: string[] = []
    let puts = 0
    client.authenticatedFetch = async (url: string, init?: RequestInit) => {
      calls.push(`${(init as { method?: string })?.method || "GET"} ${url}`)
      if (url.endsWith("/init")) {
        return okJson({ uploadId: "u1", chunkSize: 4, totalChunks: 1 })
      }
      if (url.endsWith("/complete")) {
        return okJson({ files: [{ id: "f1", name: "a.mp4", success: true }] })
      }
      puts += 1
      if (puts === 1) {
        // First chunk attempt hangs until the chunk timeout aborts it.
        await new Promise((_resolve, reject) => {
          ;(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
      }
      return okJson({ ok: true })
    }

    const file = new File(["0123"], "a.mp4", { type: "video/mp4" })
    const result = await client.uploadFileChunked(file, {
      chunkBytes: 4,
      chunkTimeoutMs: 60,
      maxRetries: 3,
      onProgress: () => {},
    })

    assert.equal(puts, 2)
    assert.equal((result.files as Array<{ id?: string }>)[0]?.id, "f1")
    assert.ok(calls.some((call) => call.includes("/complete")))
    restore()
  })

  it("still surfaces an already-aborted signal as AbortError without network", async () => {
    const { client, restore } = useTestClient()
    let networkCalls = 0
    client.authenticatedFetch = async () => {
      networkCalls += 1
      return okJson({})
    }

    const controller = new AbortController()
    controller.abort()
    const file = new File(["0123"], "a.mp4", { type: "video/mp4" })
    await assert.rejects(
      () =>
        client.uploadFileChunked(file, {
          chunkBytes: 4,
          chunkTimeoutMs: 60,
          signal: controller.signal,
        }),
      (err: unknown) => (err as Error)?.name === "AbortError",
    )
    assert.equal(networkCalls, 0)
    restore()
  })
})
