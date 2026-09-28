"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import clsx from "clsx"
import {
  ClaudeThinkingTimeline,
  THINKING_GAP_FILLER_MS,
  inferClaudeKind,
  inferLoaderState,
  useClaudeElapsedSec,
  useFirstSeenClock,
} from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import { humanizeToolDetail } from "@/lib/run-trace"

interface IncomingStep {
  id?: string
  name?: string
  label?: string
  humanDescription?: string
  status?: string
  args?: string
  preview?: string
  durationMs?: number
  /** Activity rows: when the step began (client ms). */
  at?: number
  /** Activity rows: one-line note (sizes, sources, attempt…). */
  detail?: string
  phase?: string
  /** A human backend phrase: shown as-is, never re-mapped as a tool name. */
  verbatim?: boolean
}

interface Props {
  stage?: string | null
  pct?: number | null
  compact?: boolean
  className?: string
  steps?: IncomingStep[]
  tokens?: { total?: number; tokensIn?: number; tokensOut?: number } | null
  /**
   * The stream is still open. Between phases the header then keeps the step
   * that just finished and, after THINKING_GAP_FILLER_MS, a generic
   * «Pensando…» — never blank. False for a closed turn still waiting on its
   * persisted copy: its finished steps stay static.
   */
  live?: boolean
}

/** Re-exported: the gap handling lives in ClaudeThinkingTimeline. */
export { THINKING_GAP_FILLER_MS }

function isRunning(status?: string): boolean {
  return status === "planned" || status === "executing" || status === "running"
}

function incomingToRow(step: IncomingStep, idx: number, firstSeen: (key: string) => number): ClaudeTimelineStep {
  const rawLabel = (step.humanDescription || step.label || step.name || "Herramienta").trim()
  const label = step.verbatim ? rawLabel : humanizeToolDetail(rawLabel) || rawLabel
  const failed = step.status === "error" || step.status === "denied"
  const status = failed ? "error" : isRunning(step.status) ? "active" : "done"
  const details = (step.args || step.preview || "").trim()
  const id = step.id || ("in-" + idx + "-" + label)
  const note = (step.detail || "").trim()
  const startedAt = status === "active"
    ? (typeof step.at === "number" && Number.isFinite(step.at) ? step.at : firstSeen(id))
    : undefined
  return {
    id,
    label,
    tool: step.name,
    status,
    kind: inferClaudeKind({ tool: step.name, label, status }),
    loaderState: inferLoaderState({ tool: step.name, label, status }),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(note ? { note } : {}),
    ...(status !== "active" && typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
    expandable: details.length > 0,
    details: details || undefined,
  }
}

export const ThinkingPlaceholder = ({ stage, compact = false, className, steps, tokens, live = true }: Props) => {
  const tokenTotal = tokens
    ? Number(tokens.total || (tokens.tokensIn || 0) + (tokens.tokensOut || 0))
    : 0
  const tokenHint = tokenTotal > 0 ? ` · ${tokenTotal.toLocaleString()} tokens` : ""
  const label = ((typeof stage === "string" && stage.trim()) ? stage.trim() : "Pensando…") + tokenHint
  const [history, setHistory] = useState<string[]>([])
  const lastRef = useRef<string | null>(null)
  const incoming = useMemo(() => (Array.isArray(steps) ? steps : []), [steps])
  const hasSteps = incoming.length > 0
  // Whole-turn counter only for the steps-less stage fallback; real steps
  // count their own seconds from when they began.
  const elapsedSec = useClaudeElapsedSec(!hasSteps)
  const firstSeen = useFirstSeenClock()

  useEffect(() => {
    if (lastRef.current && lastRef.current !== label) {
      setHistory((h) => [...h, lastRef.current!].slice(-12))
    }
    lastRef.current = label
  }, [label])

  const stepRows = useMemo(
    () => incoming.map((s, i) => incomingToRow(s, i, firstSeen)),
    [incoming, firstSeen],
  )

  const rows = useMemo(() => {
    if (hasSteps) return stepRows
    const completed = history.filter((h) => h && h !== label).map((h, i) => ({
      id: "hist-" + i + "-" + h,
      label: h,
      status: "done" as const,
      kind: inferClaudeKind({ label: h, status: "done" }),
    }))
    return [
      ...completed,
      {
        id: "active-" + label,
        label,
        status: "active" as const,
        kind: inferClaudeKind({ label, status: "active" }),
        loaderState: inferLoaderState({ label, status: "active" }),
        elapsedSec,
      },
    ]
  }, [hasSteps, stepRows, history, label, elapsedSec])

  // Silence between phases (all steps settled) is the timeline's: it keeps a
  // header while the stream is live instead of going blank.
  return <ClaudeThinkingTimeline steps={rows} compact={compact} live={hasSteps && live} className={clsx(className)} />
}
