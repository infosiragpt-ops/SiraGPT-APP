// codex-engine-mapping — PURE fold of Codex V2 run SSE events into the /code
// chat's existing turn-render state. No React, no network: fully unit-testable.
//
// The /code chat panel renders each turn with a streaming `content` string, an
// `agentLabel`, a `agentPhases` rail (Plan → Contexto → Generar → Aplicar →
// Verificar) and, when files were written, an actions/metrics Worked Summary.
// This helper turns the typed Codex event envelopes (narrative_delta,
// reasoning_*, action_start/end, run_summary, run_status) into a compact
// projection the imperative `runCodexEngine` can splat onto the turn — mapping
// onto the SAME phase keys `runEngine`/`buildApp` use, never inventing new UI.

import type { CodexEventEnvelope } from "@/lib/codex/timeline-reducer"

export type CodexEnginePhaseName = "plan" | "context" | "generate" | "apply" | "verify"

export interface CodexEngineFoldState {
  /** Live narrative + reasoning text, in first-seen order → the turn content. */
  narrative: string
  /** File paths seen in `file_write` actions (bounded post-terminal file pull). */
  writtenPaths: string[]
  /** File paths seen in `file_read` actions (Items-read metric). */
  readPaths: string[]
  /** Count of terminal/command actions the run ran (for the label detail). */
  commandCount: number
  /** Latest run_status seen ('queued' | 'running' | 'waiting_approval' | …). */
  status: string | null
  /** Final metrics from `run_summary` (Codex projection of CodexRunMetric). */
  summaryMetrics: Record<string, unknown> | null
  /** Which coarse render phase we're in, derived from the events so far. */
  phase: CodexEnginePhaseName
  /** seq dedup — reconnection/replay overlap is ignored. */
  seen: Set<number>
  /** Per-reasoning-block accumulators, keyed by blockId. */
  reasoning: Record<string, string>
}

export function initialCodexEngineFold(): CodexEngineFoldState {
  return {
    narrative: "",
    writtenPaths: [],
    readPaths: [],
    commandCount: 0,
    status: null,
    summaryMetrics: null,
    phase: "plan",
    seen: new Set<number>(),
    reasoning: {},
  }
}

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"])

export function isCodexTerminalStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status)
}

function pushUnique(list: string[], value: string | undefined | null): void {
  if (value && !list.includes(value)) list.push(value)
}

/**
 * Fold ONE Codex event into the render state. Pure: returns the SAME reference
 * when the event changes nothing (heartbeat / dup seq / unknown type) so callers
 * can cheaply skip a setTurns. Mutates a shallow-cloned state otherwise.
 */
export function foldCodexEvent(
  state: CodexEngineFoldState,
  event: CodexEventEnvelope,
): CodexEngineFoldState {
  const seq = typeof event.seq === "number" ? event.seq : undefined
  if (seq !== undefined && state.seen.has(seq)) return state
  const data = event.data || {}

  // Ignore types that change nothing so callers can cheaply skip a re-render.
  const NOOP_TYPES = new Set([
    "heartbeat",
    "reasoning_end",
    "action_end",
    "plan_proposed",
    "checkpoint_created",
    "action_required",
  ])
  if (NOOP_TYPES.has(event.type)) return state

  // Clone once up front for the mutating branches; keep the input reference for
  // any unknown type (early return below).
  const s: CodexEngineFoldState = {
    ...state,
    writtenPaths: state.writtenPaths.slice(),
    readPaths: state.readPaths.slice(),
    seen: new Set(state.seen),
    reasoning: { ...state.reasoning },
  }

  switch (event.type) {
    case "run_status": {
      s.status = data.status ?? s.status
      break
    }

    case "narrative_delta": {
      s.narrative += String(data.text || "")
      if (s.phase === "plan" || s.phase === "context") s.phase = "generate"
      break
    }

    case "reasoning_start": {
      const id = String(data.blockId || `r${seq ?? 0}`)
      if (!(id in s.reasoning)) s.reasoning[id] = ""
      if (s.phase === "plan") s.phase = "context"
      break
    }
    case "reasoning_delta": {
      const id = String(data.blockId || `r${seq ?? 0}`)
      s.reasoning[id] = (s.reasoning[id] || "") + String(data.text || "")
      if (s.phase === "plan" || s.phase === "context") s.phase = "generate"
      break
    }

    case "action_start": {
      if (data.kind === "file_write") {
        pushUnique(s.writtenPaths, data.path)
        s.phase = "apply"
      } else if (data.kind === "file_read") {
        pushUnique(s.readPaths, data.path)
        if (s.phase === "plan" || s.phase === "context") s.phase = "generate"
      } else if (data.kind === "terminal") {
        s.commandCount += 1
        if (s.phase === "plan" || s.phase === "context") s.phase = "generate"
      }
      break
    }

    case "run_summary": {
      s.summaryMetrics = (data.metrics as Record<string, unknown>) || {}
      s.phase = "verify"
      break
    }

    default:
      return state // unknown type: no-op, keep the input reference
  }

  if (seq !== undefined) s.seen.add(seq)
  return s
}

/**
 * The best "assistant content" string to show while streaming: narrative first
 * (the agent's live prose), else the concatenated reasoning blocks. Bounded so a
 * runaway trace can't blow up the turn size (mirrors runEngine's 12k slice).
 */
export function codexLiveContent(state: CodexEngineFoldState, cap = 12000): string {
  const reasoningText = Object.values(state.reasoning).join("\n").trim()
  const text = state.narrative.trim() || reasoningText
  return text.slice(0, cap)
}
