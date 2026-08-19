import assert from "node:assert/strict"
import { createRequire } from "node:module"
import * as path from "node:path"
import { describe, it } from "node:test"

// Anchor CJS resolution at the repo root (the runner always runs from the
// repo root) so backend requires work no matter where test-dist lives.
const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))

const { createResilientFetch } = cjsRequire("./backend/src/utils/resilient-fetch") as {
  createResilientFetch: (opts: Record<string, unknown>) => {
    send: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; headers: { get(name: string): string | null } }>
  }
}

function response(status: number) {
  return {
    status,
    headers: { get: (_name: string) => null },
  }
}

describe("resilient-fetch caller abort handling", () => {
  it("does not start a request when the caller signal is already aborted", async () => {
    const caller = new AbortController()
    caller.abort("client_disconnected")
    let calls = 0

    const client = createResilientFetch({
      fetch: async () => {
        calls += 1
        return response(200)
      },
      maxAttempts: 2,
      deadlineMs: 1_000,
      backoff: { next: () => 0 },
    })

    await assert.rejects(
      client.send("https://api.example.test/abort", { signal: caller.signal }),
      (err: any) => err?.name === "AbortedError" && err?.code === "ABORTED",
    )
    assert.equal(calls, 0, "pre-aborted caller signal must short-circuit before fetch")
  })

  it("keeps caller abort listeners balanced during normal retries (one abortable backoff sleep, no leaks)", async () => {
    // Contract since 5950c2c36 ("fix(backend): abort deadline retry backoff
    // promptly"): each backoff wait attaches exactly ONE abort listener to the
    // caller signal — so a caller abort interrupts the sleep immediately — and
    // removes it as soon as the wait ends. The resilient-fetch layer itself
    // must NOT wrap/merge the caller signal per attempt (fetch receives the
    // original signal), and no listener may leak after send() resolves.
    const caller = new AbortController()
    const originalAdd = caller.signal.addEventListener.bind(caller.signal)
    const originalRemove = caller.signal.removeEventListener.bind(caller.signal)
    let added = 0
    let removed = 0

    caller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "abort") added += 1
      return originalAdd(type, listener, options)
    }) as AbortSignal["addEventListener"]

    caller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") removed += 1
      return originalRemove(type, listener, options)
    }) as AbortSignal["removeEventListener"]

    let calls = 0
    const client = createResilientFetch({
      fetch: async (_url: string, init?: { signal?: AbortSignal }) => {
        calls += 1
        assert.equal(init?.signal, caller.signal, "fetch receives the original caller signal")
        return response(calls === 1 ? 503 : 200)
      },
      maxAttempts: 2,
      deadlineMs: 1_000,
      backoff: { next: () => 1 },
    })

    const res = await client.send("https://api.example.test/retry", { signal: caller.signal })

    assert.equal(res.status, 200)
    assert.equal(calls, 2)
    assert.equal(added, 1, "exactly one abort listener per backoff sleep — sleep must stay abortable, attempts must not merge/wrap the caller signal")
    assert.equal(removed, added, "every backoff abort listener is detached — no leak after send() resolves")
  })
})
