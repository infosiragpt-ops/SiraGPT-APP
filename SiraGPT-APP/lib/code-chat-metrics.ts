// code-chat-metrics — REAL action log + "Worked Summary" data for a /code chat
// turn that did file work. Every number is measured, never invented: line +/-
// come from a true diff of each written file against its prior content, time is
// wall-clock start→finish, counts are the actual files written/read.

import { computeLineDiff } from "./code-workspace-utils"

export type CodeChatActionKind = "file_write" | "file_read" | "terminal" | "reasoning"
export type CodeChatAction = { kind: CodeChatActionKind; label: string }
export type CodeChatMetrics = {
  timeWorkedMs: number
  actionsCount: number
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  /** Lines read from files the agent inspected this turn ("Items read"). */
  itemsReadLines: number
  /** Real token usage from the stream's `usage` frame (Agent Usage). */
  tokensIn?: number
  tokensOut?: number
  /** Real USD cost when the model's price is known; omitted otherwise.
   *  Original = provider list price; applied = after the plan policy. */
  costOriginalUsd?: number
  costAppliedUsd?: number
}

/** "$0.0123" / "$1.20" — compact USD label; "<$0.0001" for tiny non-zero costs. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0"
  if (usd < 0.0001) return "<$0.0001"
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

const GLYPHS: Record<CodeChatActionKind, string> = {
  terminal: ">_",
  file_read: "📖",
  file_write: "✎",
  reasoning: "🧠",
}

/** Compact glyph for the collapsed action row (e.g. ">_ 📖 ✎"). */
export function glyphForAction(kind: string): string {
  return GLYPHS[kind as CodeChatActionKind] ?? ">_"
}

/** "12 s" / "2 min" / "2 min 5 s" — human duration for the Worked Summary. */
export function formatWorked(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s` : `${m} min`
}

export interface BuildMetricsInput {
  startedAt: number
  now: number
  /** Prior content of a path (empty string for a newly-created file). */
  getPrevContent?: (path: string) => string
  /** Files the agent READ during the turn (OpenCode build reads the tree back).
   *  Each contributes a file_read action + its line count to "Items read". */
  read?: Array<{ path: string; content: string }>
}

const countLines = (s: string): number => (s ? s.split("\n").length : 0)

/**
 * Build the action list + Worked-Summary metrics for a turn that wrote (and
 * optionally read) files. linesAdded/Removed are summed from a real per-file
 * diff against the prior content; a brand-new file counts all its lines as added.
 * itemsReadLines sums the lines of every file the agent read.
 */
export function buildWriteMetrics(
  written: Array<{ path: string; content: string }>,
  input: BuildMetricsInput,
): { actions: CodeChatAction[]; metrics: CodeChatMetrics } {
  const getPrev = input.getPrevContent || (() => "")
  let linesAdded = 0
  let linesRemoved = 0
  let itemsReadLines = 0
  const actions: CodeChatAction[] = []

  for (const r of input.read || []) {
    itemsReadLines += countLines(r.content)
    actions.push({ kind: "file_read", label: r.path })
  }

  for (const f of written) {
    const diff = computeLineDiff(getPrev(f.path), f.content)
    for (const d of diff) {
      if (d.kind === "added") linesAdded += 1
      else if (d.kind === "removed") linesRemoved += 1
    }
    actions.push({ kind: "file_write", label: f.path })
  }

  return {
    actions,
    metrics: {
      timeWorkedMs: Math.max(0, input.now - input.startedAt),
      actionsCount: actions.length,
      filesChanged: written.length,
      linesAdded,
      linesRemoved,
      itemsReadLines,
    },
  }
}
