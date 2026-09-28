"use client"

import { ClaudeAsterisk } from "@/components/claude-asterisk"

import React, { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { formatThinkingDuration } from "@/components/thinking-trace"
import { ClaudeThinkingTimeline, inferClaudeKind, inferLoaderState, useFirstSeenClock, useThrottledValue } from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import type { AgentStepClient, AgentRunClient, AgentPermissionClient } from "@/lib/chat-context-integrated"
import { humanToolLabel, humanizeToolDetail } from "@/lib/run-trace"
import { latestReasoningHeadline } from "@/lib/chat/live-progress"

export type AgentTraceProps = {
  reasoning?: string
  reasoningStreaming?: boolean
  reasoningDurationMs?: number | null
  steps: AgentStepClient[]
  run?: AgentRunClient | null
  permission?: AgentPermissionClient | null
  onPermissionAnswered?: () => void
  /**
   * What the model is doing between tool calls (the live `agent_model`
   * pipeline phase: «Decidiendo el siguiente paso» · «paso 2 de 10 · DeepSeek
   * V4 Pro»). Shown while the run is active and no tool row is running.
   */
  liveStage?: { label: string; detail?: string; at: number } | null
}

function prettyJsonOrRaw(raw?: string): string {
  const value = (raw || "").trim()
  if (!value) return ""
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}

function formatSearchLatency(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  return `${(ms / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} s`
}

// «8 fuentes · 180 ms» for a finished web search (Búsqueda rápida).
export function searchMetaLabel(search: NonNullable<AgentStepClient["search"]>, durationMs?: number): string {
  const parts = [search.count > 0 ? `${search.count} ${search.count === 1 ? "fuente" : "fuentes"}` : "sin resultados"]
  const latency = formatSearchLatency(search.latencyMs ?? durationMs)
  if (latency) parts.push(latency)
  if (search.cached) parts.push("caché")
  return parts.join(" · ")
}

function stepToRow(step: AgentStepClient, firstSeen: (key: string) => number): ClaudeTimelineStep {
  const running = step.status === "planned" || step.status === "executing"
  const failed = step.status === "error" || step.status === "denied" || Boolean(step.isError)
  const status = failed ? "error" : running ? "active" : "done"
  const label = humanizeToolDetail(step.humanDescription) || humanToolLabel(step.name)
  const details = prettyJsonOrRaw(step.args) || prettyJsonOrRaw(step.preview)
  const durationMs = typeof step.durationMs === "number" && Number.isFinite(step.durationMs) && step.durationMs >= 0 ? step.durationMs : undefined
  return {
    id: step.id,
    label,
    tool: step.name,
    status,
    kind: inferClaudeKind({ tool: step.name, label, status }),
    loaderState: inferLoaderState({ tool: step.name, label, status }),
    ...(status === "active" ? { startedAt: firstSeen(step.id) } : {}),
    // Finished tools say how long they took (a search says more: sources + latency).
    ...(status !== "active" && durationMs !== undefined ? { durationMs } : {}),
    expandable: Boolean(details),
    details: details || undefined,
    ...(status === "done" && step.search
      ? { meta: searchMetaLabel(step.search, step.durationMs), sources: step.search.sources }
      : {}),
  }
}

export default function AgentTrace({ reasoning = "", reasoningStreaming = false, reasoningDurationMs, steps, run, liveStage }: AgentTraceProps) {
  const t = useTranslations("agent")
  const tThink = useTranslations("thinking")
  const active = reasoningStreaming || ["queued", "running", "paused", "waiting_approval"].indexOf(run?.status || "") >= 0 || (!run && steps.some((s) => s.status === "planned" || s.status === "executing"))
  // Blocked on the user (approval) or paused: nothing is progressing, so no
  // animated «Pensando…» and no ticking seconds — a static line says why.
  const blocked = !reasoningStreaming && (run?.status === "waiting_approval" || run?.status === "paused")
  const working = active && !blocked
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const expanded = userToggled !== null ? userToggled : active
  const firstSeen = useFirstSeenClock()
  const headline = useThrottledValue(reasoningStreaming ? latestReasoningHeadline(reasoning) : "", 1500)
  const toolCount = run?.toolCalls ?? steps.length
  const durationMs = run?.durationMs ?? reasoningDurationMs ?? 0
  const prettyDuration = formatThinkingDuration(Math.max(durationMs, 1000))
  const headerLabel = active
    ? t("working")
    : run?.status === "interrupted"
      ? t("interrupted")
      : tThink("thoughtFor", { duration: prettyDuration })
  const rows = useMemo(() => {
    const out: ClaudeTimelineStep[] = []
    if ((reasoning || "").trim() || reasoningStreaming) {
      const thinkingLive = reasoningStreaming && steps.length === 0
      out.push({
        id: "agent-think",
        label: reasoningStreaming ? tThink("thinking") : tThink("thought"),
        status: reasoningStreaming && steps.length === 0 ? "active" : "done",
        kind: reasoningStreaming && steps.length === 0 ? "loader" : "dot",
        loaderState: reasoningStreaming && steps.length === 0 ? "pensando" : undefined,
        ...(thinkingLive ? { startedAt: firstSeen("agent-think") } : {}),
        ...(thinkingLive && headline ? { note: headline } : {}),
        expandable: Boolean((reasoning || "").trim()),
        details: (reasoning || "").trim() || undefined,
        detailsKind: "prose",
      })
    }
    steps.forEach((s) => out.push(stepToRow(s, firstSeen)))
    // Between tool calls the model is deciding / writing: say so (with the
    // step and model when the backend reports it) instead of going silent.
    if (working && !out.some((row) => row.status === "active")) {
      const stageLabel = (liveStage?.label || "").trim()
      const stageNote = (liveStage?.detail || "").trim() || headline
      out.push({
        id: "agent-live-stage",
        label: stageLabel || tThink("thinking"),
        status: "active",
        kind: "loader",
        loaderState: "pensando",
        startedAt: stageLabel && typeof liveStage?.at === "number" ? liveStage.at : firstSeen(`agent-live-${out.length}`),
        ...(stageNote ? { note: stageNote } : {}),
      })
    }
    return out
  }, [reasoning, reasoningStreaming, steps, working, liveStage, headline, firstSeen, tThink])

  if (!steps.length && !(reasoning || "").trim() && !active) return null
  return (
    <div className="mb-2.5 w-full max-w-2xl">
      {active ? (
        <>
          <ClaudeThinkingTimeline steps={rows} />
          {blocked ? (
            <p data-agent-blocked={run?.status} className="ml-7 font-sans text-[12.5px] leading-5 text-[var(--think-dim)]">
              {run?.status === "paused" ? t("paused") : t("waitingApproval")}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setUserToggled(!expanded)}
            aria-expanded={expanded}
            aria-label={t("traceAria")}
            className="think-row group flex w-full items-center gap-2 bg-transparent px-1 py-0.5 text-left text-[13px] text-[var(--step-done)] hover:text-[var(--think-text)]"
          >
            <span className="flex h-5 w-5 items-center justify-center text-[var(--step-done)]"><ClaudeAsterisk size={14} active={false} color="currentColor" /></span>
            <svg className="think-chevron h-3 w-3 shrink-0 text-[var(--step-done)]" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="min-w-0 truncate font-sans text-[13px] text-[var(--step-done)] group-hover:text-[var(--think-text)]">{headerLabel}</span>
            {run?.status !== "interrupted" && toolCount > 0 ? (
              <span data-step-meta="1" className="shrink-0 font-sans text-[12px] tabular-nums text-[var(--think-dim)]">· {tThink("steps", { count: toolCount })}</span>
            ) : null}
          </button>
          {expanded ? <ClaudeThinkingTimeline steps={rows} /> : null}
        </>
      )}
    </div>
  )
}
