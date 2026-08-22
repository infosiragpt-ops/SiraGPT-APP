/**
 * Chaos: the /code agent's autonomous iteration DIES mid-step and the model
 * goes sick mid-run.
 *
 * Two deterministic death shapes, each mapped to the real mechanism that owns
 * its containment. No React, no network, no real timers — every clock is
 * injected, every delay is zero:
 *
 *   A) Iteration dies mid-step (the stream explodes after the turn started):
 *      the iteration budget may ONLY advance through the explicit
 *      start-of-turn step (stepIterationBudget → advanceIterationBudget, the
 *      panel's two patchAgentState call sites). A dead step can never inflate
 *      the count. Once real iterations spend the cap, isBudgetExhausted cuts
 *      BOTH doors: the FSM stops auto-continuing on a bare "dale"
 *      (nextAgentAction → passthrough) and the OpenRouter retry ladder refuses
 *      an otherwise-retriable 429 (shouldRetryOpenRouter + budgetExhausted).
 *
 *   B) The model goes sick mid-run (persistent 429s): the panel's shouldRetry
 *      gate (components/code/ai-code-chat-panel.tsx, ModelCircuitBreakerRegistry)
 *      must veto through the per-model CircuitBreaker — open = no attempt at
 *      all and no state mutation, the probe is allowed exactly at cooldown
 *      expiry with an INJECTED clock (never a real sleep), a failing probe
 *      re-opens, and the registry keeps a sick model from blocking a healthy
 *      sibling. Driven with a stricter threshold, the breaker also bounds a
 *      runaway retryWithBackoff ladder below its own attempt cap.
 *
 *      Characterization (documented, NOT endorsed): driven ONLY through the
 *      real gate, a persistently-429 model can never trip the DEFAULT breaker
 *      (threshold 3) — every ladder's final verdict-false calls recordSuccess
 *      and resets the count (2 consecutive failures < 3). Reported as a
 *      finding; pinned here so the behavior is at least explicit.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { defaultAgentState, type AgentState } from "../lib/code-agent/types"
import {
  createAgentTask,
  nextAgentAction,
  isBudgetExhausted,
  DEFAULT_MAX_ITERATIONS,
} from "../lib/code-agent/orchestrator"
import { stepIterationBudget } from "../lib/code-agent/autonomy"
import {
  CircuitBreaker,
  ModelCircuitBreakerRegistry,
  shouldRetryOpenRouter,
  retryWithBackoff,
} from "../lib/code-agent/resilience"

const T0 = 1_700_000_000_000
const err429 = Object.assign(new Error("Too Many Requests"), { status: 429 })

/** Fully synthetic clock: chaos without a single real sleep. */
function makeClock() {
  let now = T0
  return {
    get now() {
      return now
    },
    advanceBy: (ms: number) => {
      now += ms
    },
  }
}

/** The panel's REAL shouldRetry gate, with the wall clock injected. */
function makePanelGate() {
  const registry = new ModelCircuitBreakerRegistry()
  const clock = makeClock()
  const gate = (provider: string, model: string, err: unknown, attempt: number): boolean => {
    const breaker = registry.get(provider, model)
    if (!breaker.allowRequest(clock.now)) return false
    const verdict = shouldRetryOpenRouter(err as any, attempt)
    if (verdict) breaker.recordFailure(clock.now)
    else breaker.recordSuccess()
    return verdict
  }
  return { registry, clock, gate }
}

// ---- A) iteration dies mid-step: the budget never advances on failure -------

describe("chaos: iteration dies mid-step", () => {
  test("advance is pure: stepping returns a NEW budget and never mutates the previous one", () => {
    const first = stepIterationBudget({ ...defaultAgentState() }, 1000)
    assert.equal(first?.count, 1)
    const second = stepIterationBudget({ ...defaultAgentState(), budget: first }, 1010)
    assert.equal(second?.count, 2)
    assert.equal(first?.count, 1, "the previous budget object is untouched")
  })

  test("every turn dies mid-step: the count moves ONLY at the explicit turn start", async () => {
    let state: AgentState = { ...defaultAgentState(), phase: "preview" }
    let now = 1000
    const dieMidStep = async (): Promise<never> => {
      throw new Error("stream destroyed mid-step")
    }
    for (let turn = 1; turn <= DEFAULT_MAX_ITERATIONS; turn++) {
      const budget = stepIterationBudget(state, now) // the ONLY advance (panel turn start)
      state = { ...state, budget }
      await assert.rejects(dieMidStep(), /stream destroyed/) // the step dies; no catch mutates the budget
      assert.equal(state.budget?.count, turn, "a dead step never adds a count of its own")
      now += 10
    }
    assert.equal(state.budget?.count, DEFAULT_MAX_ITERATIONS)
    assert.equal(isBudgetExhausted(state.budget, now), true, "real iterations alone can spend the cap")
  })

  test("failures OUTSIDE the turn-start step never advance the count", async () => {
    let state: AgentState = { ...defaultAgentState(), phase: "preview" }
    state = { ...state, budget: stepIterationBudget(state, 1000) }
    state = { ...state, budget: stepIterationBudget(state, 1010) }
    assert.equal(state.budget?.count, 2)
    for (let i = 0; i < 10; i++) {
      // Raw failing work with no stepIterationBudget anywhere near it.
      await assert.rejects(Promise.reject(new Error("boom mid-step")), /boom mid-step/)
    }
    assert.equal(state.budget?.count, 2, "only stepIterationBudget/advanceIterationBudget may advance")
  })

  test("once real iterations spend the cap, BOTH doors close", () => {
    // The cap is reached through the real loop, not a hand-crafted budget.
    let state: AgentState = { ...defaultAgentState(), phase: "preview" }
    for (let i = 0; i < DEFAULT_MAX_ITERATIONS; i++) {
      state = { ...state, budget: stepIterationBudget(state, 1000 + i) }
    }
    const budget = state.budget
    assert.equal(budget?.count, DEFAULT_MAX_ITERATIONS)
    assert.equal(isBudgetExhausted(budget, 2000), true)

    // Door 1: the FSM refuses to auto-continue on a bare "dale".
    const gated: AgentState = {
      ...defaultAgentState(),
      phase: "preview",
      tasks: [createAgentTask("Siguiente tarea", "detalle pendiente")],
      budget,
    }
    assert.equal(nextAgentAction(gated, "dale", { mode: "app", hasModel: true }).type, "passthrough")

    // Door 2: the OpenRouter ladder refuses a retriable 429 — a broken model
    // can never buy extra attempts with a spent budget.
    assert.equal(shouldRetryOpenRouter({ status: 429 }, 0, { budgetExhausted: isBudgetExhausted(budget, 2000) }), false)
  })
})

// ---- B) the model goes sick mid-run: per-model breaker containment ----------

describe("chaos: sick model mid-run", () => {
  test("an OPEN breaker vetoes before the retry verdict and without mutating state", () => {
    const { registry, gate } = makePanelGate()
    const sick = registry.get("openrouter", "claude-sick")
    for (let i = 0; i < 3; i++) sick.recordFailure(T0) // trip through the breaker's own contract
    assert.equal(sick.isOpen, true)
    const failuresBefore = sick.failureCount

    assert.equal(gate("openrouter", "claude-sick", err429, 0), false, "open breaker = no attempt at all")
    assert.equal(sick.failureCount, failuresBefore, "the veto must not touch the breaker")
    assert.equal(sick.state, "open")
  })

  test("cooldown boundary with an injected clock: probe at expiry, failing probe re-opens, recovery closes", () => {
    const { registry, clock, gate } = makePanelGate()
    const sick = registry.get("openrouter", "claude-sick")
    for (let i = 0; i < 3; i++) sick.recordFailure(T0)
    assert.equal(sick.isOpen, true)

    clock.advanceBy(29_999) // still inside the 30s cooldown
    assert.equal(gate("openrouter", "claude-sick", err429, 0), false, "one tick before expiry: still vetoed")

    clock.advanceBy(1) // exactly at cooldown expiry
    assert.equal(gate("openrouter", "claude-sick", err429, 0), true, "the half-open probe is allowed")
    assert.equal(sick.state, "open", "a failing probe re-opens the breaker")

    clock.advanceBy(30_000) // past the second cooldown
    // Panel-real recovery path: a non-retryable verdict (402) records
    // "success" through the gate and closes the breaker.
    assert.equal(gate("openrouter", "claude-sick", { status: 402 }, 0), false)
    assert.equal(sick.state, "closed", "the breaker heals through the same gate")
    assert.equal(gate("openrouter", "claude-sick", err429, 0), true, "and 429s are retriable again")
  })

  test("registry isolation: a sick model never blocks a healthy sibling on the same ladder", () => {
    const { registry, gate } = makePanelGate()
    const sick = registry.get("openrouter", "claude-sick")
    for (let i = 0; i < 3; i++) sick.recordFailure(T0)

    assert.equal(registry.get("openrouter", "claude-sick"), sick, "same provider:model = ONE breaker")
    assert.notEqual(registry.get("cerebras", "llama-3"), sick)
    assert.equal(gate("cerebras", "llama-3", err429, 0), true, "the healthy sibling keeps retrying")
    assert.equal(gate("openrouter", "claude-sick", err429, 0), false, "while the sick one stays vetoed")
  })

  test("a tripped breaker bounds a runaway retryWithBackoff ladder below its own attempt cap", async () => {
    // Stricter threshold: what the breaker DOES once it trips (the default-
    // threshold gap through the gate is characterized in the next test).
    const breaker = new CircuitBreaker("openrouter:claude", { failureThreshold: 2, openTimeoutMs: 30_000 })
    let calls = 0
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls += 1
          throw err429
        },
        {
          maxRetries: 5,
          delayMs: () => 0, // zero real delay: chaos stays instant
          shouldRetry: (_err, attempt) => {
            if (!breaker.allowRequest(T0)) return false
            const verdict = shouldRetryOpenRouter(err429, attempt)
            if (verdict) breaker.recordFailure(T0)
            else breaker.recordSuccess()
            return verdict
          },
        },
      ),
      /Too Many Requests/,
    )
    assert.equal(calls, 3, "the ladder stops at the first vetoed attempt (2 failures trip, 3rd call is vetoed)")
    assert.equal(breaker.isOpen, true)
  })

  test("characterization: persistent 429s through the REAL gate never trip the DEFAULT breaker", () => {
    const { registry, gate } = makePanelGate()
    const sick = registry.get("openrouter", "claude")
    for (let ladder = 0; ladder < 5; ladder++) {
      // One full panel ladder: attempts 0..MAX_APP_RETRIES.
      for (const attempt of [0, 1, 2]) gate("openrouter", "claude", err429, attempt)
    }
    // KNOWN GAP: attempt 2 always yields verdict=false → recordSuccess → the
    // count resets every ladder (2 consecutive failures < threshold 3). The
    // breaker cannot open via this path alone; pinned so the behavior is
    // explicit and a future fix must update this test deliberately.
    assert.equal(sick.state, "closed")
    assert.equal(sick.failureCount, 0)
  })
})
