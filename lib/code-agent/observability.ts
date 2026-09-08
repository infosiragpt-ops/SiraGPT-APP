/**
 * code-agent · runtime observability.
 *
 * Lightweight, dependency-free telemetry for the /code agent. Each run emits
 * phase timings (plan → generate → apply → verify), streaming latency, and an
 * outcome (success | error | stopped | aborted) which feeds per-mode success
 * rates. Storage is bounded: an in-memory ring buffer (latest N runs) plus an
 * append-only JSONL file under the workspace (no external service).
 *
 * Runs are decorated with a `sessionId` (random per page load / module
 * lifetime) and a `userId` when provided, so concurrent /code sessions do not
 * interleave and the summary can be scoped per session.
 *
 * The module is deliberately side-effect free except for the explicit
 * `<timestamp>.jsonl` persistence, which is guarded by `SIRAGPT_OBSERVABILITY`
 * and a `.data/code-agent/observability/` path that lives outside the tracked
 * tree. All reads go through the in-memory state, so summary/list never touch
 * the disk on the hot path.
 */

export type CodeAgentOutcome = "success" | "error" | "stopped" | "aborted"

export type CodeAgentPhaseName =
  | "context"
  | "generate"
  | "apply"
  | "verify"
  | "plan"
  | "stream"

export interface CodeAgentPhase {
  name: CodeAgentPhaseName
  /** Wall-clock duration in ms for the phase. */
  ms: number
  /** Optional free-form detail (e.g. "3 archivos aplicados", error message). */
  detail?: string
}

export interface CodeAgentRun {
  id: string
  sessionId: string
  userId?: string
  /** Composer mode for the run, when known (app/build/deps/plan/debug/ask/image). */
  mode?: string
  /** True when the turn was a conversational reply (no file work). */
  conversational: boolean
  startedAt: number
  finishedAt: number
  /** Total run duration in ms. */
  totalMs: number
  /** Time-to-first-byte of the model stream, in ms. */
  streamLatencyMs?: number
  outcome: CodeAgentOutcome
  phases: CodeAgentPhase[]
  /** Bounded list of file paths the run wrote to the workspace. */
  files?: string[]
  /** Token usage reported by the stream, when available. */
  usage?: { tokensIn: number; tokensOut: number }
}

export type RunPhaseTotals = Record<CodeAgentPhaseName, number>

/** Shape consumed by the panel and any future endpoint, kept stable. */
export interface CodeAgentSnapshot {
  sessionId: string
  runs: CodeAgentRun[]
  counters: {
    byPhase: RunPhaseTotals
    byOutcome: Record<CodeAgentOutcome, number>
    byMode: Record<string, { runs: number; success: number }>
  }
  totals: {
    runs: number
    successRate: number
    avgTotalMs: number
    avgStreamLatencyMs: number
    avgGenerateMs: number
  }
}

export interface ObservabilityConfig {
  sessionId?: string
  userId?: string
  /** Max runs kept in memory (ring buffer). */
  maxRuns?: number
  /** TTL for in-memory runs, in ms (0 = never expire). */
  expireAfterMs?: number
  /** Directory for the append-only JSONL persistence; defaults under PRIVATE_DIR. */
  logDir?: string
  /** Disable the file persistence entirely (pure in-memory mode). */
  disablePersistence?: boolean
}

export const DEFAULT_MAX_RUNS = 200
export const DEFAULT_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000
export const DEFAULT_LOG_DIR = ".data/code-agent/observability"

declare global {
  interface Window {
    /** Set to "off" to disable client-side persistence at runtime. */
    __SIRAGPT_OBSERVABILITY__?: string
  }
}

const PHASE_NAMES: readonly CodeAgentPhaseName[] = [
  "context",
  "generate",
  "apply",
  "verify",
  "plan",
  "stream",
]

function createId(prefix: string): string {
  const uuid = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}-${uuid}`
}

/**
 * Deterministic RNG (mulberry32) for tests and for the expiring-ring buffer.
 * `Math.random` is unaffected, so behavior remains reproducible when a seed is
 * given and normally random otherwise.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Entry point for every recorded run. `id`/`sessionId` are optional: they
 * default to a fresh uuid and the module's session respectively. Appends the
 * run to the in-memory ring buffer, persists one JSONL line (when enabled) and
 * returns the resolved run so callers can attach the id to UI state.
 */
export type CodeAgentRunInput = Omit<CodeAgentRun, "id" | "sessionId"> & {
  id?: string
  sessionId?: string
}

export function recordRun(run: CodeAgentRunInput): CodeAgentRun {
  const resolved: CodeAgentRun = {
    ...run,
    id: run.id || createId("run"),
    sessionId: run.sessionId || state.sessionId,
  } as CodeAgentRun
  state.runs = [...state.runs, resolved]
  if (state.expireAfterMs > 0) {
    // Opportunistic sweep on writes, not on the hot read path.
    const cutoff = Date.now() - state.expireAfterMs
    state.runs = state.runs.filter((r) => r.finishedAt >= cutoff)
  }
  if (state.runs.length > state.maxRuns) {
    state.runs = state.runs.slice(state.runs.length - state.maxRuns)
  }
  persistRun(resolved)
  return resolved
}

/** Delete recorded runs (e.g. a session reset). Returns the number removed. */
export function resetObservability(): number {
  const removed = state.runs.length
  state.runs = []
  return removed
}

/** All in-memory runs, newest first. Copy, so callers cannot mutate state. */
export function listRuns(): CodeAgentRun[] {
  return [...state.runs].reverse()
}

/** Runs finished after `since` (ms epoch); empty when the buffer has none. */
export function listRunsSince(sinceMs: number): CodeAgentRun[] {
  return listRuns().filter((r) => r.finishedAt >= sinceMs)
}

export function getRun(runId: string): CodeAgentRun | undefined {
  return state.runs.find((r) => r.id === runId)
}

/**
 * Bounded-size window of the most recent runs (newest first). Useful for
 * debugging surfaces (dev console, debug panel) that want a compact history.
 */
export function recentRuns(limit = 10): CodeAgentRun[] {
  return listRuns().slice(0, Math.max(0, limit))
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  return sum(values) / values.length
}

/** One-line summary (per-session when `sessionId` is provided). */
export function summarizeObservability(sessionId?: string | null): CodeAgentSnapshot {
  const runs = sessionId ? state.runs.filter((r) => r.sessionId === sessionId) : state.runs
  const byPhase = Object.fromEntries(PHASE_NAMES.map((p) => [p, 0])) as RunPhaseTotals
  const byOutcome = { success: 0, error: 0, stopped: 0, aborted: 0 }
  const byMode: Record<string, { runs: number; success: number }> = {}
  const generateMs: number[] = []
  const streamLatencyMs: number[] = []
  const totalMs: number[] = []

  for (const run of runs) {
    byOutcome[run.outcome] += 1
    for (const phase of run.phases) {
      if (phase.name in byPhase) byPhase[phase.name] += 1
      if (phase.name === "generate") generateMs.push(phase.ms)
    }
    if (run.streamLatencyMs != null) streamLatencyMs.push(run.streamLatencyMs)
    totalMs.push(run.totalMs)
    if (run.mode) {
      const entry = (byMode[run.mode] ||= { runs: 0, success: 0 })
      entry.runs += 1
      if (run.outcome === "success") entry.success += 1
    }
  }

  const completed = runs.length || 1
  return {
    sessionId: runs[0]?.sessionId ?? state.sessionId,
    runs: [...runs].reverse(),
    counters: { byPhase, byOutcome, byMode },
    totals: {
      runs: runs.length,
      successRate: byOutcome.success / completed,
      avgTotalMs: avg(totalMs) ?? 0,
      avgStreamLatencyMs: avg(streamLatencyMs) ?? 0,
      avgGenerateMs: avg(generateMs) ?? 0,
    },
  }
}

/**
 * JSONL persistence via the server-side store route. The panel is
 * client-side, so writing files directly here would pull `node:fs` into the
 * webpack client graph (and fail CI with "Unhandled scheme"). Instead we POST
 * the run to `/api/code-agent/observability`, which appends it to a daily
 * JSONL under `.data/code-agent/observability/` (outside the git tree).
 * Best-effort: any failure is swallowed — observability never touches the
 * agent's hot path.
 */
export function persistRun(run: CodeAgentRun): boolean {
  if (state.disablePersistence) return false
  if (typeof window === "undefined") return false
  if (window.__SIRAGPT_OBSERVABILITY__?.toLowerCase() === "off") return false
  // Fire-and-forget: never await, never surface errors to the UI.
  void fetch("/api/code-agent/observability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run }),
    keepalive: true,
  }).catch(() => {})
  return true
}

// ---- module state (isolated per bundle/worker; not shared across processes) --

interface ObservabilityState {
  sessionId: string
  userId?: string
  maxRuns: number
  expireAfterMs: number
  logDir: string
  disablePersistence: boolean
  runs: CodeAgentRun[]
}

/**
 * In-memory state. Defaults are production-sane; tests call
 * `configureObservability({ disablePersistence: true, ... })` first. Because
 * some bundles (e.g. the Next.js panel import graph) can hoist module state
 * across HMR boundaries, the persistence flag is re-checked inside
 * `persistRun` against `SIRAGPT_OBSERVABILITY=off` as a second gate.
 */
const state: ObservabilityState = {
  sessionId: createId("sess"),
  maxRuns: DEFAULT_MAX_RUNS,
  expireAfterMs: DEFAULT_EXPIRE_AFTER_MS,
  logDir: DEFAULT_LOG_DIR,
  disablePersistence: false,
  runs: [],
}

export function configureObservability(config: ObservabilityConfig): void {
  if (config.sessionId !== undefined) state.sessionId = config.sessionId
  if (config.userId !== undefined) state.userId = config.userId
  if (config.maxRuns !== undefined) state.maxRuns = Math.max(1, config.maxRuns)
  if (config.expireAfterMs !== undefined) state.expireAfterMs = Math.max(0, config.expireAfterMs)
  if (config.logDir !== undefined) state.logDir = config.logDir
  if (config.disablePersistence !== undefined) state.disablePersistence = config.disablePersistence
}

export function getSessionId(): string {
  return state.sessionId
}

export function getObservabilityState(): Readonly<{
  sessionId: string
  userId?: string
  maxRuns: number
  expireAfterMs: number
  logDir: string
  runs: number
}> {
  return {
    sessionId: state.sessionId,
    userId: state.userId,
    maxRuns: state.maxRuns,
    expireAfterMs: state.expireAfterMs,
    logDir: state.logDir,
    runs: state.runs.length,
  }
}

/**
 * Deprecated no-op kept for type/tests stability: persistence moved to the
 * server-side store (`lib/code-agent/observability-store.ts` + the API route).
 * Reads on the client go through `GET /api/code-agent/observability`.
 */
export function readLogLines(_logDir?: string): string[] {
  return []
}