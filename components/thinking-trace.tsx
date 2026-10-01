"use client"

import { useMemo, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ClaudeThinkingTimeline,
  inferClaudeKind,
  inferLoaderState,
  useFirstSeenClock,
  useThrottledValue,
} from "@/components/claude-thinking-timeline"
import type { ClaudeTimelineCollapsed, ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import { humanToolLabel, humanizeToolDetail } from "@/lib/run-trace"
import {
  OWNED_ELSEWHERE_PHASES,
  answerTextForCounter,
  createIncrementalWordCounter,
  formatCount,
  hasAgentSentinel,
  latestReasoningHeadline,
} from "@/lib/chat/live-progress"

export type ThinkingToolCall = {
  index: number
  name?: string
  args?: string
}

export type ThinkingActivityStep = {
  id: string
  label: string
  tool?: string
  status: "active" | "done" | "error"
  /** When the step began (client ms on live turns, relative on reloads). */
  at?: number
  endedAt?: number
  /** Server-measured duration of a settled pipeline phase. */
  durationMs?: number
  /** One-line note: sizes, sources, attempt… */
  detail?: string
  /** Pipeline phase (stage v3): attachments, memory, rag, web, model, post… */
  phase?: string
  stageId?: string
}

export type ThinkingTraceProps = {
  reasoning: string
  streaming: boolean
  durationMs?: number | null
  toolCalls?: ThinkingToolCall[]
  // Live activity steps from the backend `stage` frames (Leyendo el archivo
  // adjunto, Buscando en la web, Analizando la imagen…). Rendered before the
  // reasoning row so the trace reads like Claude's: what was done, then what
  // was thought.
  activity?: ThinkingActivityStep[]
  /**
   * The answer of this turn: `streaming` while the turn is live, `text` its
   * content. Once text flows the trace folds into one line («Redactando la
   * respuesta · 420 palabras»); when the turn ends, «Pensó durante 47 s ·
   * 7 pasos». Without it the trace stays expanded (legacy callers).
   */
  answer?: { streaming: boolean; text: string }
}

/** Phases that make a turn worth a trace line even when it was quick. */
const SUBSTANTIAL_PHASES: ReadonlySet<string> = new Set(["attachments", "rag", "web", "doc_analysis", "history", "artifact", "vision"])
/** Legacy stage frames carry no phase: their tool says the same. */
const SUBSTANTIAL_TOOLS: ReadonlySet<string> = new Set(["read_file", "web_search", "web_fetch", "rag_retrieve", "compact", "vision"])
/**
 * A quick turn with nothing substantial before its text («hola») shows no
 * trace line at all — decided when the text starts, never shown then removed.
 */
const TRIVIAL_TURN_MS = 4000
/** Live word count label refresh (ms). */
const WORD_COUNT_THROTTLE_MS = 250
/** Live reasoning headline refresh (ms). */
const HEADLINE_THROTTLE_MS = 1500

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
  const humanized = humanizeToolDetail(name)
  if (humanized) return humanized
  const n = String(name || "").toLowerCase()
  if (n.indexOf("search") >= 0) return t("toolSearching")
  if (n.indexOf("read") >= 0 || n.indexOf("url") >= 0 || n.indexOf("browse") >= 0) return t("toolReading")
  if (n.indexOf("bash") >= 0 || n.indexOf("exec") >= 0 || n.indexOf("python") >= 0 || n.indexOf("run") >= 0) return t("toolRunning")
  return t("toolUsing", { name: name || "tool" })
}

/** «1.240» in Spanish (grouped by hand: es does not group 4 digits); the locale's own grouping elsewhere. */
export function formatWordCount(count: number, locale: string): string {
  if (!locale || /^es\b/i.test(locale)) return formatCount(count)
  try {
    return new Intl.NumberFormat(locale).format(Math.max(0, Math.round(count)))
  } catch {
    return formatCount(count)
  }
}

function stepDurationMs(step: ThinkingActivityStep, next?: ThinkingActivityStep): number | undefined {
  if (step.status === "active") return undefined
  if (typeof step.durationMs === "number" && Number.isFinite(step.durationMs) && step.durationMs >= 0) return step.durationMs
  const end = typeof step.endedAt === "number"
    ? step.endedAt
    : !step.stageId && next && typeof next.at === "number" ? next.at : null
  if (end === null || typeof step.at !== "number") return undefined
  const ms = end - step.at
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export default function ThinkingTrace({ reasoning, streaming, durationMs, toolCalls, activity, answer }: ThinkingTraceProps) {
  const t = useTranslations("thinking")
  const locale = useLocale()
  const firstSeen = useFirstSeenClock()
  const reasoningText = (reasoning || "").trim()
  const answerText = answer ? answerTextForCounter(answer.text) : ""
  const hasAnswerText = answerText.trim().length > 0
  const turnLive = answer ? answer.streaming : streaming
  // The agentic loop's sentinel is in the answer: AgenticSteps draws the loop
  // and owns the live status line; this trace only lists what came before.
  const agentic = Boolean(answer && hasAgentSentinel(answer.text))
  const composing = Boolean(answer && answer.streaming && hasAnswerText && !streaming)
  const done = Boolean(answer && !answer.streaming && !streaming)
  const folded = composing || done
  // Triviality is judged once, when the text starts (pre-text facts only),
  // and kept through the end of the turn: a line never shows then vanishes.
  const trivialVerdictRef = useRef<boolean | null>(null)
  if (!folded) trivialVerdictRef.current = null

  // Live line of thought: first sentence of the paragraph being written.
  const headline = useThrottledValue(streaming ? latestReasoningHeadline(reasoning) : "", HEADLINE_THROTTLE_MS)
  // Words written so far, counted incrementally and refreshed ≤4×/s.
  const counterRef = useRef<ReturnType<typeof createIncrementalWordCounter> | null>(null)
  if (!counterRef.current) counterRef.current = createIncrementalWordCounter()
  const wordCount = counterRef.current(answerText)
  const shownWords = useThrottledValue(composing ? wordCount : 0, WORD_COUNT_THROTTLE_MS)
  const composeStartedAt = hasAnswerText && turnLive ? firstSeen("compose") : undefined

  const activitySteps = useMemo(
    () => (activity || []).filter((step) => step && (step.label || "").trim() && !OWNED_ELSEWHERE_PHASES.has(step.phase || "")),
    [activity],
  )
  // Compaction is actual pipeline work, even if an earlier acknowledgement
  // or reasoning chunk is already visible. Keep its live status above the
  // generic thinking/answer line until the server sends its terminal event.
  const compacting = turnLive && activitySteps.some((step) => step.tool === "compact" && step.status === "active")
  const hasReasoning = Boolean(reasoningText) || (toolCalls?.length ?? 0) > 0
  if (!hasReasoning && !streaming && activitySteps.length === 0) return null

  const wordsLabel = (count: number) => t("words", { count, value: formatWordCount(count, locale) })
  const rows: ClaudeTimelineStep[] = []
  activitySteps.forEach((step, i) => {
    // A "Pensando" stage is the reasoning row itself — never duplicate it.
    if (/^pensando/i.test(step.label)) return
    // A legacy row (no stageId) has no result frame: it only runs while the
    // reasoning streams. A pipeline stage row runs until its own result —
    // unless AgenticSteps owns the live line.
    const rowLive = streaming || (turnLive && (!agentic || step.tool === "compact") && Boolean(step.stageId))
    const status = step.status === "error" ? "error" : step.status === "active" && rowLive ? "active" : "done"
    const note = (step.detail || "").trim()
    const duration = status === "active" ? undefined : stepDurationMs(step, activitySteps[i + 1])
    rows.push({
      id: "activity-" + step.id,
      label: step.label,
      tool: step.tool,
      status,
      kind: inferClaudeKind({ tool: step.tool, label: step.label, status }),
      loaderState: inferLoaderState({ tool: step.tool, label: step.label, status }),
      ...(status === "active" ? { startedAt: typeof step.at === "number" ? step.at : firstSeen("activity-" + step.id) } : {}),
      ...(note ? { note } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    })
  })
  // Folded (answer streaming / done) the summary line carries «Pensó durante»;
  // the reasoning row then only exists when there is reasoning to read.
  if (streaming || reasoningText || (!folded && activitySteps.length > 0)) {
    const thinkingLive = streaming && !(toolCalls && toolCalls.length) && !compacting
    rows.push({
      id: "think-header",
      label: streaming
        ? t("thinking")
        : folded
          ? t("thought")
          : (durationMs && durationMs > 0 ? t("thoughtFor", { duration: formatThinkingDuration(durationMs) }) : t("thought")),
      status: thinkingLive ? "active" : "done",
      kind: thinkingLive ? "loader" : "dot",
      loaderState: thinkingLive ? "pensando" : undefined,
      ...(thinkingLive ? { startedAt: firstSeen("think-header") } : {}),
      ...(thinkingLive && headline ? { note: headline } : {}),
      expandable: Boolean(reasoningText),
      details: reasoningText || undefined,
      // Live chain-of-thought streams as prose (Claude style); once the
      // answer arrives it folds into "Pensó durante N s".
      detailsKind: "prose",
      defaultOpen: streaming && Boolean(reasoningText),
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
      loaderState: inferLoaderState({ tool: call.name, label, status }),
      ...(status === "active" ? { startedAt: firstSeen("tool-" + call.index) } : {}),
      expandable: Boolean((call.args || "").trim()),
      details: (call.args || "").trim() || undefined,
    })
  })

  // Work steps only: the reasoning row and the composed-answer row are not steps.
  const workSteps = rows.filter((row) => row.id.startsWith("activity-") || row.id.startsWith("tool-")).length
  if (folded && trivialVerdictRef.current === null) {
    const substantial = Boolean(reasoningText) || (toolCalls?.length ?? 0) > 0 || activitySteps.some(
      (step) => SUBSTANTIAL_PHASES.has(step.phase || "") || SUBSTANTIAL_TOOLS.has(step.tool || ""),
    )
    const summed = rows.reduce((sum, row) => sum + (typeof row.durationMs === "number" ? row.durationMs : 0), 0)
    const preTextMs = durationMs && durationMs > 0 ? durationMs : summed
    trivialVerdictRef.current = !substantial && preTextMs < TRIVIAL_TURN_MS
  }
  if (folded && trivialVerdictRef.current) return null
  // An agentic turn without reasoning: once the loop hands over its answer,
  // AgenticSteps' own line is the turn's summary — no second «Pensó durante».
  if (folded && agentic && !reasoningText && !compacting) return null

  let collapsed: ClaudeTimelineCollapsed | null = null
  let timelineRows = rows
  if (composing) {
    // The answer is streaming: one quiet line. A post-text phase (checking
    // the sources, generating the file…) takes it while it runs.
    const postRow = [...rows].reverse().find((row) => row.status === "active" && activitySteps.some(
      (step) => "activity-" + step.id === row.id && (step.phase === "post" || step.tool === "compact"),
    ))
    collapsed = postRow
      ? { live: true, label: postRow.label, startedAt: postRow.startedAt, announce: postRow.label }
      : { live: true, label: `${t("composing")} · ${wordsLabel(shownWords || wordCount)}`, startedAt: composeStartedAt, announce: t("composing") }
    timelineRows = rows.filter((row) => row !== postRow)
  } else if (done) {
    const summed = rows.reduce((sum, row) => sum + (typeof row.durationMs === "number" ? row.durationMs : 0), 0)
    const totalMs = durationMs && durationMs > 0 ? durationMs : summed
    const words = answerText ? wordCount : 0
    timelineRows = words > 0
      ? [
        ...rows,
        {
          id: "compose-done",
          label: t("composed"),
          status: "done" as const,
          kind: "check" as const,
          note: wordsLabel(words),
        },
      ]
      : rows
    collapsed = {
      live: false,
      label: totalMs > 0 ? t("thoughtFor", { duration: formatThinkingDuration(totalMs) }) : t("thought"),
      ...(workSteps > 0 ? { meta: t("steps", { count: workSteps }) } : {}),
    }
  }

  // Before the first answer token (all phases settled, reasoning done) the
  // header keeps saying that work is happening instead of going silent.
  const preTextLive = Boolean(answer && answer.streaming && !hasAnswerText && !agentic)
  return <ClaudeThinkingTimeline steps={timelineRows} collapsed={collapsed} live={preTextLive} />
}
