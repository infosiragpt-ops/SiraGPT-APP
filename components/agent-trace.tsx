"use client"

import React, { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { formatThinkingDuration } from "@/components/thinking-trace"
import { ClaudeThinkingTimeline, inferClaudeKind, inferLoaderState, useClaudeElapsedSec } from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import type { AgentStepClient, AgentRunClient, AgentPermissionClient } from "@/lib/chat-context-integrated"
import { collapseSuccessLabel, humanToolLabel, humanizeToolDetail } from "@/lib/run-trace"

export type AgentTraceProps = {
  reasoning?: string
  reasoningStreaming?: boolean
  reasoningDurationMs?: number | null
  steps: AgentStepClient[]
  run?: AgentRunClient | null
  permission?: AgentPermissionClient | null
  onPermissionAnswered?: () => void
}

function prettyJsonOrRaw(raw?: string): string {
  const value = (raw || "").trim()
  if (!value) return ""
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}

function stepToRow(step: AgentStepClient, elapsedSec: number): ClaudeTimelineStep {
  const running = step.status === "planned" || step.status === "executing"
  const failed = step.status === "error" || step.status === "denied" || Boolean(step.isError)
  const status = failed ? "error" : running ? "active" : "done"
  const label = humanizeToolDetail(step.humanDescription) || humanToolLabel(step.name)
  const details = prettyJsonOrRaw(step.args) || prettyJsonOrRaw(step.preview)
  return {
    id: step.id,
    label,
    tool: step.name,
    status,
    kind: inferClaudeKind({ tool: step.name, label, status }),
    loaderState: inferLoaderState({ tool: step.name, label, status }),
    elapsedSec: status === "active" ? elapsedSec : null,
    expandable: Boolean(details),
    details: details || undefined,
  }
}

export default function AgentTrace({ reasoning = "", reasoningStreaming = false, reasoningDurationMs, steps, run }: AgentTraceProps) {
  const t = useTranslations("agent")
  const active = reasoningStreaming || ["queued", "running", "paused", "waiting_approval"].indexOf(run?.status || "") >= 0 || (!run && steps.some((s) => s.status === "planned" || s.status === "executing"))
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const expanded = userToggled !== null ? userToggled : active
  const elapsedSec = useClaudeElapsedSec(active)
  const toolCount = run?.toolCalls ?? steps.length
  const durationMs = run?.durationMs ?? reasoningDurationMs ?? 0
  const prettyDuration = formatThinkingDuration(Math.max(durationMs, 1000))
  const headerLabel = active
    ? t("working")
    : run?.status === "interrupted"
      ? t("interrupted")
      : collapseSuccessLabel(Math.max(1, Math.round((durationMs || 1000) / 1000)))
  const rows = useMemo(() => {
    const out: ClaudeTimelineStep[] = []
    if ((reasoning || "").trim() || reasoningStreaming) {
      out.push({
        id: "agent-think",
        label: reasoningStreaming ? "Pensando…" : "Pensando",
        status: reasoningStreaming && steps.length === 0 ? "active" : "done",
        kind: reasoningStreaming && steps.length === 0 ? "loader" : "dot",
        loaderState: reasoningStreaming && steps.length === 0 ? "pensando" : undefined,
        elapsedSec: reasoningStreaming && steps.length === 0 ? elapsedSec : null,
        expandable: Boolean((reasoning || "").trim()),
        details: (reasoning || "").trim() || undefined,
      })
    }
    steps.forEach((s) => out.push(stepToRow(s, elapsedSec)))
    return out
  }, [reasoning, reasoningStreaming, steps, elapsedSec])

  if (!steps.length && !(reasoning || "").trim() && !active) return null
  return (
    <div className="mb-2.5 w-full max-w-2xl">
      {active ? (
        <ClaudeThinkingTimeline steps={rows} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setUserToggled(!expanded)}
            aria-expanded={expanded}
            aria-label={t("traceAria")}
            className="think-row group flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left"
          >
            <span className="flex h-5 w-5 items-center justify-center"><span className="block h-[7px] w-[7px] rounded-full" style={{ background: "#8A8580" }} /></span>
            <svg className="think-chevron h-3 w-3 shrink-0 text-[#8A8580]" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="min-w-0 truncate text-[13.5px] font-sans text-[#8A8580]">{headerLabel}</span>
          </button>
          {expanded ? <ClaudeThinkingTimeline steps={rows} /> : null}
        </>
      )}
    </div>
  )
}
