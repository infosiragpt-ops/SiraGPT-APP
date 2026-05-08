/**
 * retry-after-fetch — pins the Retry-After parsing + backoff
 * fallback. Two properties matter:
 *
 *   1. RFC 9110 conformance: both delta-seconds and HTTP-date
 *      forms of Retry-After are honored.
 *
 *   2. Bounded retries with jitter + cap. A misbehaving server
 *      that keeps returning 429 with a 1-hour Retry-After does
 *      NOT pin the client to a 1-hour wait; the cap kicks in.
 *
 * Real fetch is replaced by an injected stub so the test runs
 * in node:test without a network. Real timers are replaced by
 * an injected sleep so the test doesn't actually wait.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  retryAfterFetch,
  RETRY_AFTER_FETCH_DEFAULTS,
} from "../lib/retry-after-fetch"

function makeFetchStub(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  let i = 0
  const calls: Array<{ input: any; init?: RequestInit }> = []
  const stub: any = async (input: any, init?: RequestInit) => {
    calls.push({ input, init })
    const r = responses[i] || responses[responses.length - 1]
    i += 1
    return makeResponse(r)
  }
  stub.calls = () => calls
  return stub
}

function makeResponse({ status, headers = {}, body = "" }: { status: number; headers?: Record<string, string>; body?: string }) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    status,
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null
      },
    },
    body: { cancel: async () => undefined } as any,
    async text() { return body },
    async json() { return body ? JSON.parse(body) : null },
  } as unknown as Response
}

describe("retryAfterFetch — non-retryable statuses pass through", () => {
  test("200 OK is returned without a retry", async () => {
    const fetchStub = makeFetchStub([{ status: 200, body: '{"ok":true}' }])
    const sleeps: number[] = []
    const res = await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
    })
    assert.equal(res.status, 200)
    assert.equal(fetchStub.calls().length, 1)
    assert.equal(sleeps.length, 0)
  })

  test("400 Bad Request is returned without a retry", async () => {
    const fetchStub = makeFetchStub([{ status: 400 }])
    const res = await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
    })
    assert.equal(res.status, 400)
    assert.equal(fetchStub.calls().length, 1)
  })
})

describe("retryAfterFetch — Retry-After: delta-seconds", () => {
  test("honors `Retry-After: 5` and retries with 5000ms wait", async () => {
    const fetchStub = makeFetchStub([
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200, body: '{"ok":true}' },
    ])
    const sleeps: number[] = []
    const onWaitCalls: any[] = []
    const res = await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      onWait: (info) => onWaitCalls.push(info),
    })
    assert.equal(res.status, 200)
    assert.equal(sleeps.length, 1)
    assert.equal(sleeps[0], 5000)
    assert.equal(onWaitCalls[0].source, "header-seconds")
    assert.equal(onWaitCalls[0].status, 429)
  })

  test("clamps absurd Retry-After to maxBackoffMs", async () => {
    const fetchStub = makeFetchStub([
      { status: 429, headers: { "retry-after": "3600" } },
      { status: 200 },
    ])
    const sleeps: number[] = []
    await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      maxBackoffMs: 5_000,
    })
    assert.equal(sleeps[0], 5_000, "1-hour Retry-After must be capped at maxBackoffMs")
  })
})

describe("retryAfterFetch — Retry-After: HTTP-date", () => {
  test("honors a future HTTP-date and waits the difference", async () => {
    // Pin a fake clock so the HTTP-date calculation is deterministic.
    const fixedNow = Date.parse("2026-05-03T00:00:00Z")
    const targetIso = "Sun, 03 May 2026 00:00:30 GMT" // 30 s in the future
    const fetchStub = makeFetchStub([
      { status: 503, headers: { "retry-after": targetIso } },
      { status: 200 },
    ])
    const sleeps: number[] = []
    await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      now: () => fixedNow,
    })
    assert.equal(sleeps[0], 30_000)
  })

  test("HTTP-date already in the past → wait of 0ms (server says 'retry now')", async () => {
    const fixedNow = Date.parse("2026-05-03T00:01:00Z")
    const targetIso = "Sun, 03 May 2026 00:00:30 GMT" // 30 s in the past
    const fetchStub = makeFetchStub([
      { status: 503, headers: { "retry-after": targetIso } },
      { status: 200 },
    ])
    const sleeps: number[] = []
    await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      now: () => fixedNow,
    })
    assert.equal(sleeps[0], 0)
  })
})

describe("retryAfterFetch — backoff fallback when Retry-After missing", () => {
  test("uses exponential backoff (with jitter, capped) when no header", async () => {
    const fetchStub = makeFetchStub([
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ])
    const sleeps: number[] = []
    const onWaitCalls: any[] = []
    await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      baseBackoffMs: 1000,
      maxBackoffMs: 10_000,
      onWait: (info) => onWaitCalls.push(info),
    })
    // Two retries → two waits. First in [850, 1300] (base * jitter),
    // second in [1700, 2600] (2*base * jitter). Lax bounds because
    // jitter is non-deterministic.
    assert.equal(sleeps.length, 2)
    assert.ok(sleeps[0] >= 800 && sleeps[0] <= 1400, `first wait ~${sleeps[0]} should be near base`)
    assert.ok(sleeps[1] > sleeps[0], `second wait ${sleeps[1]} should grow beyond ${sleeps[0]}`)
    assert.equal(onWaitCalls[0].source, "backoff")
  })
})

describe("retryAfterFetch — exhaustion", () => {
  test("returns the last 429 after maxRetries with no further wait", async () => {
    const fetchStub = makeFetchStub([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 }, // last attempt; not retried
    ])
    const sleeps: number[] = []
    const res = await retryAfterFetch("https://api.example.com/x", undefined, {
      fetchImpl: fetchStub,
      sleepFn: async (ms) => { sleeps.push(ms) },
      maxRetries: 3,
      baseBackoffMs: 1, // minimum
      maxBackoffMs: 1000,
    })
    assert.equal(res.status, 429)
    assert.equal(fetchStub.calls().length, 4) // initial + 3 retries
    assert.equal(sleeps.length, 3) // one wait between each retry pair
  })
})

describe("retryAfterFetch — defaults exposure", () => {
  test("RETRY_AFTER_FETCH_DEFAULTS reflects the documented constants", () => {
    assert.equal(RETRY_AFTER_FETCH_DEFAULTS.DEFAULT_MAX_RETRIES, 3)
    assert.equal(RETRY_AFTER_FETCH_DEFAULTS.DEFAULT_BASE_BACKOFF_MS, 500)
    assert.equal(RETRY_AFTER_FETCH_DEFAULTS.DEFAULT_MAX_BACKOFF_MS, 30_000)
    assert.ok(RETRY_AFTER_FETCH_DEFAULTS.RETRYABLE_STATUSES.has(429))
    assert.ok(RETRY_AFTER_FETCH_DEFAULTS.RETRYABLE_STATUSES.has(503))
  })
})

describe("retryAfterFetch — bounded attempts and cancellation", () => {
  test("times out a hung attempt and aborts the attempt signal", async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchStub: any = async (_input: any, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined
      return new Promise<Response>(() => undefined)
    }

    await assert.rejects(
      retryAfterFetch("https://api.example.com/hung", undefined, {
        fetchImpl: fetchStub,
        timeoutMs: 10,
        maxRetries: 0,
      }),
      (error: any) => {
        assert.equal(error.name, "RetryAfterFetchTimeoutError")
        assert.equal(error.code, "RETRY_AFTER_FETCH_TIMEOUT")
        assert.equal(error.timeoutMs, 10)
        assert.equal(error.attempt, 1)
        return true
      },
    )
    assert.equal(capturedSignal?.aborted, true)
  })

  test("external abort before the first attempt prevents fetch from running", async () => {
    const controller = new AbortController()
    const reason = new Error("caller stopped")
    controller.abort(reason)
    let calls = 0

    await assert.rejects(
      retryAfterFetch("https://api.example.com/abort", { signal: controller.signal }, {
        fetchImpl: (async () => {
          calls += 1
          return makeResponse({ status: 200 })
        }) as any,
      }),
      /caller stopped/,
    )
    assert.equal(calls, 0)
  })

  test("external abort during Retry-After sleep stops waiting immediately", async () => {
    const controller = new AbortController()
    const fetchStub = makeFetchStub([
      { status: 429, headers: { "retry-after": "30" } },
      { status: 200 },
    ])

    await assert.rejects(
      retryAfterFetch("https://api.example.com/retry", { signal: controller.signal }, {
        fetchImpl: fetchStub,
        sleepFn: async () => new Promise<void>(() => undefined),
        onWait: () => controller.abort(new Error("stop waiting")),
      }),
      /stop waiting/,
    )
    assert.equal(fetchStub.calls().length, 1)
  })
})

describe("retryAfterFetch — request init sanitization", () => {
  test("strips SDK metadata from headers before native fetch sees init", async () => {
    let capturedInit: RequestInit | undefined
    const fetchStub: any = async (_input: any, init?: RequestInit) => {
      capturedInit = init
      return makeResponse({ status: 200 })
    }

    const headers: Record<PropertyKey, unknown> = {
      accept: "application/json",
      "x-attempt": 2,
      "x-null": null,
      "x-symbol-value": Symbol("skip"),
    }
    headers[Symbol("sdk-metadata")] = "not-a-header"
    const init: any = { headers }
    init[Symbol("init-metadata")] = "not-fetch-init"

    const res = await retryAfterFetch("https://api.example.com/safe", init, {
      fetchImpl: fetchStub,
      maxRetries: 0,
    })

    assert.equal(res.status, 200)
    assert.deepEqual(capturedInit?.headers, {
      accept: "application/json",
      "x-attempt": "2",
    })
    assert.equal(Object.getOwnPropertySymbols(capturedInit || {}).length, 0)
    assert.equal(Object.getOwnPropertySymbols((capturedInit?.headers || {}) as object).length, 0)
  })
})
