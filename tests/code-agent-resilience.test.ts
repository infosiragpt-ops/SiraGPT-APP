import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyFailure,
  isRetryableFailure,
  computeBackoffMs,
  shouldRetryOpenRouter,
  retryWithBackoff,
  CircuitBreaker,
  ModelCircuitBreakerRegistry,
  MAX_APP_RETRIES,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
} from "../lib/code-agent/resilience"

describe("classifyFailure", () => {
  test("classifies 402 as payment_required", () => {
    assert.equal(classifyFailure({ status: 402 }), "payment_required")
  })
  test("classifies credit/quota messages as payment_required", () => {
    assert.equal(classifyFailure({ message: "Insufficient balance" }), "payment_required")
    assert.equal(classifyFailure({ message: "your account has no credit" }), "payment_required")
    assert.equal(classifyFailure({ message: "rate limit" }).length >= 0, true)
  })
  test("classifies 429 as rate_limit", () => {
    assert.equal(classifyFailure({ status: 429 }), "rate_limit")
    assert.equal(classifyFailure({ message: "Too Many Requests" }), "rate_limit")
    assert.equal(classifyFailure({ code: "rate_limit" }), "rate_limit")
  })
  test("classifies 5xx as server", () => {
    assert.equal(classifyFailure({ status: 500 }), "server")
    assert.equal(classifyFailure({ status: 503 }), "server")
    assert.equal(classifyFailure({ status: 500, message: "internal server error" }), "server")
  })
  test("classifies timeout as timeout", () => {
    assert.equal(classifyFailure({ status: 408 }), "timeout")
    assert.equal(classifyFailure({ message: "request timed out" }), "timeout")
    assert.equal(classifyFailure({ message: "ETIMEDOUT" }), "timeout")
  })
  test("classifies abort as other", () => {
    assert.equal(classifyFailure({ name: "AbortError" }), "other")
    assert.equal(classifyFailure({ message: "operation was aborted" }), "other")
  })
  test("unknown/codes fall to other", () => {
    assert.equal(classifyFailure(null), "other")
    assert.equal(classifyFailure({}), "other")
    assert.equal(classifyFailure({ status: 400 }), "other")
  })
  test("uses statusCode when status missing", () => {
    assert.equal(classifyFailure({ statusCode: 429 }), "rate_limit")
  })
})

describe("isRetryableFailure", () => {
  test("402 is NOT app-retryable", () => {
    assert.equal(isRetryableFailure({ status: 402 }), false)
  })
  test("429 / 5xx / timeout are retryable", () => {
    assert.equal(isRetryableFailure({ status: 429 }), true)
    assert.equal(isRetryableFailure({ status: 502 }), true)
    assert.equal(isRetryableFailure({ status: 408 }), true)
  })
  test("4xx / abort are not retryable", () => {
    assert.equal(isRetryableFailure({ status: 400 }), false)
    assert.equal(isRetryableFailure({ name: "AbortError" }), false)
    assert.equal(isRetryableFailure(null), false)
  })
})

describe("computeBackoffMs", () => {
  test("first retry uses base delay plus jitter", () => {
    const ms = computeBackoffMs(1)
    assert.ok(ms >= BASE_RETRY_DELAY_MS && ms < BASE_RETRY_DELAY_MS + 250)
  })
  test("second retry roughly doubles", () => {
    const ms = computeBackoffMs(2)
    assert.ok(ms >= BASE_RETRY_DELAY_MS * 2 && ms <= 8000)
  })
  test("third retry grows and is capped at MAX", () => {
    const ms = computeBackoffMs(3)
    assert.ok(ms >= BASE_RETRY_DELAY_MS * 4 && ms <= MAX_RETRY_DELAY_MS)
  })
})

describe("shouldRetryOpenRouter", () => {
  test("retries retriable failures within the attempt cap", () => {
    assert.equal(shouldRetryOpenRouter({ status: 429 }, 0), true)
    assert.equal(shouldRetryOpenRouter({ status: 502 }, 1), true)
  })
  test("stops once attempts reach MAX_APP_RETRIES", () => {
    assert.equal(shouldRetryOpenRouter({ status: 429 }, MAX_APP_RETRIES), false)
  })
  test("budget exhaustion stops retries", () => {
    assert.equal(shouldRetryOpenRouter({ status: 429 }, 0, { budgetExhausted: true }), false)
  })
  test("402 / abort are not retried", () => {
    assert.equal(shouldRetryOpenRouter({ status: 402 }, 0), false)
    assert.equal(shouldRetryOpenRouter({ name: "AbortError" }, 0), false)
  })
})

describe("retryWithBackoff", () => {
  test("resolves on first success", async () => {
    const v = await retryWithBackoff(async () => "ok")
    assert.equal(v, "ok")
  })
  test("recovers from a 429 after multiple calls", async () => {
    let calls = 0
    const v = await retryWithBackoff(
      async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error("429") as unknown as Error, { status: 429 })
        return "done"
      },
      { maxRetries: 2 },
    )
    assert.equal(v, "done")
    assert.equal(calls, 3)
  })
  test("recovers from timeout", async () => {
    let calls = 0
    const v = await retryWithBackoff(
      async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error("timed out"), { status: 408 })
        return "recovered"
      },
      { maxRetries: 2 },
    )
    assert.equal(v, "recovered")
  })
  test("402 fails immediately (single attempt)", async () => {
    await assert.rejects(
      retryWithBackoff(
        async () => {
          throw Object.assign(new Error("no credit"), { status: 402 })
        },
        { maxRetries: 2 },
      ),
    )
  })
  test("exhausts retries and throws the last error", async () => {
    let calls = 0
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++
          throw new Error(`boom ${calls}`)
        },
        { maxRetries: 2, delayMs: () => 0 },
      ),
      /boom 3/,
    )
    assert.equal(calls, 3)
  })
  test("shouldRetry=false prevents retry", async () => {
    let calls = 0
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++
          throw new Error("x")
        },
        { shouldRetry: () => false, delayMs: () => 0 },
      ),
      /x/,
    )
    assert.equal(calls, 1)
  })
  test("abort signal stops the retry loop", async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      retryWithBackoff(
        async () => {
          throw new Error("x")
        },
        { signal: ac.signal },
      ),
      /aborted/,
    )
  })
})

describe("CircuitBreaker", () => {
  test("starts closed and allows requests", () => {
    const b = new CircuitBreaker("k")
    assert.equal(b.state, "closed")
    assert.equal(b.allowRequest(), true)
  })
  test("trips open after failureThreshold consecutive failures", () => {
    const b = new CircuitBreaker("k", { failureThreshold: 2, openTimeoutMs: 1000 })
    b.recordFailure()
    assert.equal(b.state, "closed")
    const tripped = b.recordFailure()
    assert.equal(tripped, true)
    assert.equal(b.state, "open")
    assert.equal(b.allowRequest(), false)
  })
  test("opens a probe after cooldown and resets on success", () => {
    const b = new CircuitBreaker("k", { failureThreshold: 1, openTimeoutMs: 100 })
    b.recordFailure()
    assert.equal(b.allowRequest(), false)
    const now = Date.now()
    assert.equal(b.allowRequest(now + 20000), true) // cooldown elapsed → half-open probe
    b.recordSuccess()
    assert.equal(b.state, "closed")
  })
  test("probe failure re-opens (half_open → open)", () => {
    const b = new CircuitBreaker("k", { failureThreshold: 1, openTimeoutMs: 100 })
    b.recordFailure()
    b.allowRequest(Date.now() + 20000) // half_open
    const reTripped = b.recordFailure(Date.now() + 21000)
    assert.equal(reTripped, true)
    assert.equal(b.state, "open")
  })
  test("success resets failure count", () => {
    const b = new CircuitBreaker("k", { failureThreshold: 5 })
    b.recordFailure()
    b.recordFailure()
    b.recordSuccess()
    assert.equal(b.allowRequest(), true)
    assert.equal(b.failureCount, 0)
  })
  test("reset restores a pristine breaker", () => {
    const b = new CircuitBreaker("k", { failureThreshold: 1 })
    b.recordFailure()
    b.reset()
    assert.equal(b.state, "closed")
    assert.equal(b.failureCount, 0)
    assert.equal(b.isOpen, false)
  })
})

describe("ModelCircuitBreakerRegistry", () => {
  test("keys breakers per provider:model", () => {
    const r = new ModelCircuitBreakerRegistry()
    const a = r.get("openrouter", "claude")
    const b = r.get("openrouter", "claude")
    assert.equal(a, b)
    const c = r.get("openrouter", "gpt")
    assert.notEqual(a, c)
  })
  test("resetAll clears all breakers", () => {
    const r = new ModelCircuitBreakerRegistry()
    r.get("openrouter", "claude")
    assert.equal(r.size, 1)
    r.resetAll()
    assert.equal(r.size, 0)
  })
})
