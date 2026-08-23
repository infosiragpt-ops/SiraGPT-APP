"use client"

import { useTranslations } from "next-intl"
import { ClaudeThinkingTimeline, inferClaudeKind, useClaudeElapsedSec } from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import { humanToolLabel } from "@/lib/run-trace"

export type ThinkingToolCall = {
  index: number
  name?: string
  args?: string
}

export type ThinkingTraceProps = {
  reasoning: string
  streaming: boolean
  durationMs?: number | null
  toolCalls?: ThinkingToolCall[]
}

export function formatThinkingDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return totalSeconds + " s"
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? minutes + " min " + seconds + " s" : minutes + " min"
}

export function firstReasoningSentence(reasoning: string): string {
  const clean = (reasoning || "").replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim()
  if (!clean) return ""
  const match = clean.match(/^.*?[.!?…](?:\s|$)/)
  const sentence = (match ? match[0] : clean).trim()
  return sentence.length > 140 ? sentence.slice(0, 137) + "…" : sentence
}

function describeTool(name: string | undefined, t: ReturnType<typeof useTranslations>): string {
  const mapped = humanToolLabel(name, "")
  if (mapped) return mapped
  const n = String(name || "").toLowerCase()
  if (n.indexOf("search") >= 0) return t("toolSearching")
  if (n.indexOf("read") >= 0 || n.indexOf("url") >= 0 || n.indexOf("browse") >= 0) return t("toolReading")
  if (n.indexOf("bash") >= 0 || n.indexOf("exec") >= 0 || n.indexOf("python") >= 0 || n.indexOf("run") >= 0) return t("toolRunning")
  return t("toolUsing", { name: name || "tool" })
}

export default function ThinkingTrace({ reasoning, streaming, durationMs, toolCalls }: ThinkingTraceProps) {
  const t = useTranslations("thinking")
  const elapsedSec = useClaudeElapsedSec(streaming)
  const hasReasoning = Boolean((reasoning || "").trim()) || (toolCalls?.length ?? 0) > 0
  if (!hasReasoning && !streaming) return null

  const rows: ClaudeTimelineStep[] = []
  if (streaming || (reasoning || "").trim()) {
    rows.push({
      id: "think-header",
      label: streaming ? t("thinking") : (durationMs && durationMs > 0 ? t("thoughtFor", { duration: formatThinkingDuration(durationMs) }) : t("thought")),
      status: streaming && !(toolCalls && toolCalls.length) ? "active" : "done",
      kind: streaming && !(toolCalls && toolCalls.length) ? "sunburst" : "dot",
      elapsedSec: streaming && !(toolCalls && toolCalls.length) ? elapsedSec : null,
      expandable: Boolean((reasoning || "").trim()),
      details: (reasoning || "").trim() || undefined,
    })
  }
  ;(toolCalls || []).forEach((call, i) => {
    const isLast = i === (toolCalls || []).length - 1
    const status = streaming && isLast ? "active" : "done"
    const label = describeTool(call.name, t)
    rows.push({
      id: "tool-" + call.index,
      label,
      tool: call.name,
      status,
      kind: inferClaudeKind({ tool: call.name, label, status }),
      elapsedSec: status === "active" ? elapsedSec : null,
      expandable: Boolean((call.args || "").trim()),
      details: (call.args || "").trim() || undefined,
    })
  })

  return <ClaudeThinkingTimeline steps={rows} />
}
