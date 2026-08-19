import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const cjsRequire = createRequire(__filename)

type BreakerStats = { name: string; state: "CLOSED" | "OPEN" | "HALF_OPEN"; failureCount: number; lastFailureAt: Date | null; nextAttemptAt: Date | null }
type Breaker = {
  execute: <T>(fn: () => Promise<T>) => Promise<T>
  stats: () => BreakerStats
  reset: () => void
}
type CircuitModule = {
  CircuitBreaker: new (name: string, opts?: Record<string, unknown>) => Breaker
  CircuitBreakerError: new (...a: unknown[]) => Error & { breakerName: string; state: string; nextAttemptAt: Date }
  getBreaker: (name: string, opts?: Record<string, unknown>) => Breaker
  allStats: () => BreakerStats[]
  resetAll: () => void
  STATES: { CLOSED: string; OPEN: string; HALF_OPEN: string }
}

const cb = cjsRequire("../../backend/src/services/circuit-breaker") as CircuitModule

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe("circuit-breaker · basics", () => {
  it("starts CLOSED and passes through successes", async () => {
    const b = new cb.CircuitBreaker("t-basic", { failureThreshold: 3 })
    const out = await b.execute(async () => 42)
    assert.equal(out, 42)
    assert.equal(b.stats().state, "CLOSED")
  })

  it("rethrows errors in CLOSED state without tripping until threshold hit", async () => {
    const b = new cb.CircuitBreaker("t-below-threshold", { failureThreshold: 3 })
    await assert.rejects(() => b.execute(async () => { throw new Error("boom1") }))
    await assert.rejects(() => b.execute(async () => { throw new Error("boom2") }))
    assert.equal(b.stats().state, "CLOSED", "2 < 3 failures shouldn't open")
  })

  it("trips OPEN after failureThreshold consecutive failures", async () => {
    const b = new cb.CircuitBreaker("t-trip", { failureThreshold: 2 })
    for (let i = 0; i < 2; i++) await assert.rejects(() => b.execute(async () => { throw new Error("x") }))
    assert.equal(b.stats().state, "OPEN")
  })
})

describe("circuit-breaker · short-circuit & recovery", () => {
  it("short-circuits with CircuitBreakerError while OPEN", async () => {
    const b = new cb.CircuitBreaker("t-short", { failureThreshold: 1, resetTimeoutMs: 10_000 })
    await assert.rejects(() => b.execute(async () => { throw new Error("x") }))

    let shortCircuitedBeforeCall = true
    await assert.rejects(
      () => b.execute(async () => { shortCircuitedBeforeCall = false; return "never" }),
      (err: Error) => err.name === "CircuitBreakerError"
    )
    assert.equal(shortCircuitedBeforeCall, true, "the wrapped fn must not run while OPEN")
  })

  it("transitions OPEN → HALF_OPEN after resetTimeout, then closes on a successful probe", async () => {
    const b = new cb.CircuitBreaker("t-recover", { failureThreshold: 1, resetTimeoutMs: 40 })
    await assert.rejects(() => b.execute(async () => { throw new Error("die") }))
    assert.equal(b.stats().state, "OPEN")

    await sleep(60)
    const out = await b.execute(async () => "probe-ok")
    assert.equal(out, "probe-ok")
    assert.equal(b.stats().state, "CLOSED", "successful probe should close the breaker")
  })

  it("re-opens when the HALF_OPEN probe call fails", async () => {
    const b = new cb.CircuitBreaker("t-reopen", { failureThreshold: 1, resetTimeoutMs: 40 })
    await assert.rejects(() => b.execute(async () => { throw new Error("first trip") }))
    await sleep(60)
    await assert.rejects(() => b.execute(async () => { throw new Error("probe fail") }))
    assert.equal(b.stats().state, "OPEN", "failed probe should flip back to OPEN")
  })

  it("drains failureCount on consecutive successes in CLOSED", async () => {
    const b = new cb.CircuitBreaker("t-drain", { failureThreshold: 5 })
    await assert.rejects(() => b.execute(async () => { throw new Error("1") }))
    await assert.rejects(() => b.execute(async () => { throw new Error("2") }))
    const before = b.stats().failureCount
    await b.execute(async () => "ok")
    await b.execute(async () => "ok")
    const after = b.stats().failureCount
    assert.ok(after < before, `expected failureCount to drain: before=${before}, after=${after}`)
  })
})

describe("circuit-breaker · registry", () => {
  it("getBreaker returns the same instance for the same name", () => {
    const a = cb.getBreaker("t-shared", { failureThreshold: 9 })
    const b = cb.getBreaker("t-shared")
    assert.strictEqual(a, b)
  })

  it("allStats includes every registered breaker", () => {
    cb.getBreaker("t-stats-a")
    cb.getBreaker("t-stats-b")
    const names = cb.allStats().map(s => s.name)
    assert.ok(names.includes("t-stats-a") && names.includes("t-stats-b"))
  })

  it("resetAll puts every breaker back to CLOSED", async () => {
    const b = cb.getBreaker("t-resetall", { failureThreshold: 1, resetTimeoutMs: 10_000 })
    await assert.rejects(() => b.execute(async () => { throw new Error("x") }))
    assert.equal(b.stats().state, "OPEN")
    cb.resetAll()
    assert.equal(b.stats().state, "CLOSED")
  })
})
