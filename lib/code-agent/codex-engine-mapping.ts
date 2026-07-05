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
  /**
   * Claude Code-style live action feed: every action_start appends a running
   * entry; its action_end flips it to ok/error. Keyed by actionId (fallback:
   * kind+label) so replay/reconnect can't duplicate entries.
   */
  liveActions: CodexLiveAction[]
}

export interface CodexLiveAction {
  key: string
  kind: string
  /** Human line: the file path, the command, or the action title. */
  label: string
  status: "running" | "ok" | "error"
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
    liveActions: [],
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
    liveActions: state.liveActions.slice(),
  }

  switch (event.type) {
    case "run_status": {
      s.status = data.status ?? s.status
      break
    }

    case "narrative_delta": {
      // Defense for runs persisted before the backend stripped it: a model
      // echoing its transcript encoding ("…[TOOL_RESULT]…") from that marker
      // on is regurgitated input (playbook/file bodies), not narration.
      s.narrative += String(data.text || "").split("[TOOL_RESULT")[0]
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
      // Live feed entry (Claude Code-style): running until its action_end.
      const key = String(data.actionId || `${data.kind}:${data.path || data.command || seq || ""}`)
      const label = String(data.path || data.command || data.kind || "acción")
      if (!s.liveActions.some((a) => a.key === key)) {
        s.liveActions.push({ key, kind: String(data.kind || "action"), label, status: "running" })
        if (s.liveActions.length > 30) s.liveActions.splice(0, s.liveActions.length - 30)
      }
      break
    }

    case "action_end": {
      const key = String(data.actionId || "")
      const idx = key ? s.liveActions.findIndex((a) => a.key === key) : -1
      if (idx === -1) return state // unmatched end (replay tail) → no re-render
      s.liveActions[idx] = {
        ...s.liveActions[idx],
        status: data.status === "error" ? "error" : "ok",
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

// The agent's prompted tool-calling protocol sometimes leaks into the
// narrative stream as fenced blocks (```finalize {"answer": …} / ```tool_call
// {...}). Raw JSON in the chat reads as a bug ("SIN RUTA" code card), and the
// finalize `answer` is precisely the Claude Code-style completion summary the
// user should read — so extract it as prose and drop the protocol plumbing.
const TOOL_FENCE_RE = /```(finalize|tool_call)[^\n]*\n([\s\S]*?)```/g
const OPEN_TOOL_FENCE_RE = /```(finalize|tool_call)[^\n]*\n/

function extractFinalizeAnswer(body: string): string | null {
  try {
    const parsed = JSON.parse(body.trim())
    if (parsed && typeof parsed.answer === "string" && parsed.answer.trim()) {
      return parsed.answer.trim()
    }
  } catch {
    /* not valid JSON — caller drops the block */
  }
  return null
}

export function sanitizeCodexNarrative(text: string): string {
  if (!text || !text.includes("```")) return sanitizeBareAnswer(text)
  // Closed protocol fences: finalize → its answer as prose; tool_call → drop
  // (the action chips already narrate the work).
  let out = text.replace(TOOL_FENCE_RE, (_m, lang: string, body: string) => {
    if (lang === "finalize") {
      const answer = extractFinalizeAnswer(body)
      if (answer) return `\n${answer}\n`
    }
    return "\n"
  })
  // Unterminated protocol fence at the tail (the stream can cut mid-block):
  // recover the answer if the partial body already parses, else trim it away
  // so half-typed JSON never renders.
  const open = out.match(OPEN_TOOL_FENCE_RE)
  if (open && typeof open.index === "number") {
    const head = out.slice(0, open.index)
    const body = out.slice(open.index + open[0].length)
    const answer = open[1] === "finalize" ? extractFinalizeAnswer(body) : null
    out = answer ? `${head}\n${answer}\n` : head
  }
  return sanitizeBareAnswer(out)
}

// Defensive: some runs emit the finalize payload as a bare {"answer": …} JSON
// object directly in the narrative (no fence). Replace it with the answer.
function sanitizeBareAnswer(text: string): string {
  const idx = text.indexOf('{"answer"')
  if (idx < 0) return text
  const answer = extractFinalizeAnswer(text.slice(idx))
  if (!answer) return text
  return `${text.slice(0, idx)}\n${answer}\n`
}

/**
 * The best "assistant content" string to show while streaming: narrative first
 * (the agent's live prose), else the concatenated reasoning blocks. Bounded so a
 * runaway trace can't blow up the turn size (mirrors runEngine's 12k slice).
 * Protocol fences (finalize/tool_call) are folded into prose — see above.
 */
export function codexLiveContent(state: CodexEngineFoldState, cap = 12000): string {
  const reasoningText = Object.values(state.reasoning).join("\n").trim()
  const text = sanitizeCodexNarrative(state.narrative.trim() || reasoningText).trim()
  return text.slice(0, cap)
}

const ACTION_VERB: Record<string, string> = {
  file_write: "Escribiendo",
  file_read: "Leyendo",
  terminal: "Ejecutando",
  web_search: "Buscando",
  subagent: "Subagente",
  dev_server: "Dev server",
}

/**
 * Claude Code-style live action feed as markdown, appended under the streaming
 * narrative while the run works: "⏺ Escribiendo `src/App.tsx`…" flips to ✓/✗
 * when its action_end arrives. Bounded to the LAST `max` entries so long runs
 * stay readable. Empty string when the run has no actions yet — or when the
 * run already finished (the Worked Summary takes over).
 */
export function codexLiveActionsMarkdown(state: CodexEngineFoldState, max = 8): string {
  if (!state.liveActions.length) return ""
  if (isCodexTerminalStatus(state.status)) return ""
  const recent = state.liveActions.slice(-max)
  const lines = recent.map((a) => {
    const verb = ACTION_VERB[a.kind] || "Acción"
    const mark = a.status === "running" ? "⏺" : a.status === "error" ? "✗" : "✓"
    const tail = a.status === "running" ? "…" : ""
    return `${mark} ${verb} \`${a.label}\`${tail}`
  })
  const hidden = state.liveActions.length - recent.length
  return `\n\n${hidden > 0 ? `_+${hidden} acciones previas_\n` : ""}${lines.join("\n")}`
}
