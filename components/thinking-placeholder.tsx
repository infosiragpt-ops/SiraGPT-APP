"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import clsx from "clsx"
import { ClaudeThinkingTimeline, inferClaudeKind, useClaudeElapsedSec } from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineStep } from "@/components/claude-thinking-timeline"

interface IncomingStep {
  id?: string
  name?: string
  label?: string
  humanDescription?: string
  status?: string
  args?: string
  preview?: string
  durationMs?: number
}

interface Props {
  stage?: string | null
  pct?: number | null
  compact?: boolean
  className?: string
  steps?: IncomingStep[]
}

function incomingToRow(step: IncomingStep, idx: number, elapsedSec: number, isLastActive: boolean): ClaudeTimelineStep {
  const label = (step.humanDescription || step.label || step.name || "Herramienta").trim()
  const running = step.status === "planned" || step.status === "executing" || step.status === "running"
  const failed = step.status === "error" || step.status === "denied"
  const status = failed ? "error" : (running || isLastActive && running) ? "active" : "done"
  const details = (step.args || step.preview || "").trim()
  return {
    id: step.id || ("in-" + idx + "-" + label),
    label,
    tool: step.name,
    status,
    kind: inferClaudeKind({ tool: step.name, label, status }),
    elapsedSec: status === "active" ? elapsedSec : null,
    expandable: details.length > 0,
    details: details || undefined,
  }
}

export const ThinkingPlaceholder = ({ stage, compact = false, className, steps }: Props) => {
  const label = (typeof stage === "string" && stage.trim()) ? stage.trim() : "Pensando…"
  const [history, setHistory] = useState<string[]>([])
  const lastRef = useRef<string | null>(null)
  const elapsedSec = useClaudeElapsedSec(true)

  useEffect(() => {
    if (lastRef.current && lastRef.current !== label) {
      setHistory((h) => [...h, lastRef.current!].slice(-12))
    }
    lastRef.current = label
  }, [label])
  const incoming = Array.isArray(steps) ? steps : []
  const rows = useMemo(() => {
    if (incoming.length > 0) {
      const lastRun = [...incoming].reverse().findIndex((s) => s.status === "planned" || s.status === "executing" || s.status === "running")
      return incoming.map((s, i) => incomingToRow(s, i, elapsedSec, i === incoming.length - 1 - (lastRun === -1 ? 0 : lastRun)))
    }
    const completed = history.filter((h) => h && h !== label).map((h, i) => ({
      id: "hist-" + i + "-" + h,
      label: h,
      status: "done" as const,
      kind: inferClaudeKind({ label: h, status: "done" }),
    }))
    return [
      ...completed,
      { id: "active-" + label, label, status: "active" as const, kind: inferClaudeKind({ label, status: "active" }), elapsedSec },
    ]
  }, [incoming, history, label, elapsedSec])

  return <ClaudeThinkingTimeline steps={rows} compact={compact} className={clsx(className)} />
}
