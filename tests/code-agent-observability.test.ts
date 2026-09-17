/**
 * code-agent · observability runtime — unit tests.
 *
 * Covers the ring-buffer bounds, the phase/outcome accumulation, the
 * per-session scoping, the deterministic RNG, and the JSONL persistence guard
 * (tests run with `disablePersistence: true`; the persistence path is verified
 * against the environment gate, not by writing to disk).
 */
import assert from "node:assert/strict"
import test, { beforeEach, afterEach } from "node:test"

import {
  configureObservability,
  recordRun,
  resetObservability,
  listRuns,
  listRunsSince,
  getRun,
  recentRuns,
  summarizeObservability,
  getSessionId,
  getObservabilityState,
  mulberry32,
  persistRun,
  readLogLines,
  DEFAULT_MAX_RUNS,
} from "../lib/code-agent/observability"

function makeRun(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    sessionId: "test-session",
    conversational: false,
    startedAt: now,
    finishedAt: now + 100,
    totalMs: 100,
    outcome: "success",
    phases: [],
    ...overrides,
  } as any
}

beforeEach(() => {
  // Tests stay in-memory: no JSONL writes, deterministic session id.
  configureObservability({ sessionId: "test-session", disablePersistence: true, maxRuns: DEFAULT_MAX_RUNS, expireAfterMs: 0 })
  resetObservability()
})

afterEach(() => {
  resetObservability()
  configureObservability({ disablePersistence: true })
})

test("recordRun appends and listRuns returns newest first", () => {
  const a = recordRun(makeRun({ startedAt: 1, finishedAt: 2, totalMs: 1 }))
  const b = recordRun(makeRun({ startedAt: 3, finishedAt: 5, totalMs: 2 }))
  assert.equal(listRuns().length, 2)
  assert.equal(listRuns()[0].id, b.id)
  assert.equal(listRuns()[1].id, a.id)
  assert.equal(getRun(a.id)?.totalMs, 1)
})

test("ids are unique and prefixed", () => {
  const ids = new Set(Array.from({ length: 50 }, () => {
    const r = recordRun(makeRun())
    return r.id
  }))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^run-/)
})

test("ring buffer is bounded by maxRuns", () => {
  configureObservability({ maxRuns: 5 })
  for (let i = 0; i < 20; i++) recordRun(makeRun({ totalMs: i }))
  assert.equal(listRuns().length, 5)
  // The newest 5 survive, oldest dropped.
  const totals = listRuns().map((r) => r.totalMs).sort((a, b) => a - b)
  assert.deepEqual(totals, [15, 16, 17, 18, 19])
})

test("expired runs are swept on write", () => {
  configureObservability({ expireAfterMs: 50 })
  recordRun(makeRun({ finishedAt: Date.now() - 1000 }))
  recordRun(makeRun({ finishedAt: Date.now() }))
  assert.equal(listRuns().length, 1)
})

test("resetObservability clears the buffer and returns count", () => {
  recordRun(makeRun())
  recordRun(makeRun())
  assert.equal(resetObservability(), 2)
  assert.equal(listRuns().length, 0)
})

test("listRunsSince filters by finish time", () => {
  recordRun(makeRun({ finishedAt: 100, totalMs: 10 }))
  recordRun(makeRun({ finishedAt: 500, totalMs: 20 }))
  const recent = listRunsSince(200)
  assert.equal(recent.length, 1)
  assert.equal(recent[0].totalMs, 20)
})

test("recentRuns caps the window", () => {
  for (let i = 0; i < 10; i++) recordRun(makeRun())
  assert.equal(recentRuns(3).length, 3)
  assert.equal(recentRuns().length, 10)
})

test("summarizeObservability computes phases, outcomes and rates", () => {
  recordRun(makeRun({
    mode: "app",
    phases: [
      { name: "stream", ms: 120 },
      { name: "generate", ms: 500 },
      { name: "apply", ms: 30 },
      { name: "verify", ms: 10 },
    ],
    streamLatencyMs: 120,
    totalMs: 660,
  }))
  recordRun(makeRun({
    mode: "app",
    outcome: "error",
    phases: [{ name: "stream", ms: 60 }, { name: "generate", ms: 250 }],
    streamLatencyMs: 60,
    totalMs: 310,
  }))

  const s = summarizeObservability()
  assert.equal(s.totals.runs, 2)
  assert.equal(s.counters.byOutcome.success, 1)
  assert.equal(s.counters.byOutcome.error, 1)
  assert.equal(s.counters.byPhase.generate, 2)
  assert.equal(s.counters.byPhase.apply, 1)
  assert.equal(s.totals.successRate, 0.5)
  assert.equal(s.totals.avgGenerateMs, 375) // (500 + 250) / 2
  assert.equal(s.totals.avgStreamLatencyMs, 90) // (120 + 60) / 2
  assert.deepEqual(s.counters.byMode.app, { runs: 2, success: 1 })
})

test("empty summary is a valid zero state", () => {
  const s = summarizeObservability()
  assert.equal(s.totals.runs, 0)
  assert.equal(s.totals.successRate, 0)
  assert.equal(s.totals.avgTotalMs, 0)
  assert.equal(s.totals.avgStreamLatencyMs, 0)
  assert.equal(s.counters.byOutcome.error, 0)
})

test("summarizeObservability scopes by session id", () => {
  recordRun(makeRun({ sessionId: "session-a" }))
  recordRun(makeRun({ sessionId: "session-b" }))
  const a = summarizeObservability("session-a")
  const all = summarizeObservability()
  assert.equal(a.totals.runs, 1)
  assert.equal(a.sessionId, "session-a")
  assert.equal(all.totals.runs, 2)
})

test("phases with unknown names are ignored by counters", () => {
  recordRun(makeRun({
    phases: [
      { name: "generate", ms: 100 },
      { name: "somefuturephase", ms: 999 },
    ],
  }))
  const s = summarizeObservability()
  assert.equal(s.counters.byPhase.generate, 1)
  assert.equal("somefuturephase" in s.counters.byPhase, false)
})

test("conversational runs are counted and flagged", () => {
  recordRun(makeRun({ conversational: true, mode: undefined }))
  const s = summarizeObservability()
  assert.equal(s.totals.runs, 1)
  assert.equal(s.runs[0].conversational, true)
})

test("mulberry32 is deterministic per seed and bounded [0,1)", () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const seqA = Array.from({ length: 5 }, () => a())
  const seqB = Array.from({ length: 5 }, () => b())
  assert.deepEqual(seqA, seqB)
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`)
  }
  const c = mulberry32(43)
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => c()))
})

test("persistRun is best-effort and honors disablePersistence / off gate", () => {
  configureObservability({ disablePersistence: true })
  assert.equal(persistRun(makeRun()), false)
  configureObservability({ disablePersistence: false })
  // No window in the node test runner -> client persistence is a no-op.
  // (The module state "off" flag never resolves in-process either.)
  assert.equal(persistRun(makeRun()), false)
  assert.deepEqual(readLogLines(), [])
})

test("configureObservability bounds maxRuns and exposes state", () => {
  configureObservability({ maxRuns: 0 })
  assert.equal(getObservabilityState().maxRuns, 1)
  configureObservability({ maxRuns: 500, sessionId: "other" })
  assert.equal(getObservabilityState().maxRuns, 500)
  assert.equal(getSessionId(), "other")
})

test("run ids default to the module session when none provided", () => {
  const r = recordRun({ ...makeRun({ sessionId: undefined }) })
  assert.equal(typeof r.sessionId, "string")
  assert.ok(r.sessionId.length > 0)
})