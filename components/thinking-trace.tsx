"use client"

/**
 * ThinkingTrace — Claude-style extended-thinking panel rendered ABOVE the
 * assistant message content.
 *
 * Streaming (`streaming === true`):
 *   - Shimmer "Pensando…" header with the DotmCircular15 glyph (the single
 *     canonical "pensando" SVG of the app).
 *   - Expanded by default: the chain-of-thought renders as markdown inside a
 *     height-capped scroller auto-anchored to the bottom, with tool calls
 *     interleaved as timeline rows (gray connector rail on the left, icon per
 *     tool family, readable description, collapsible chip that reveals the
 *     raw arguments through the existing CustomCodeBlock renderer).
 *
 * Done (`reasoning_done` received, or a historical message with persisted
 * reasoning):
 *   - Auto-collapses to a single line: first sentence of the reasoning as
 *     summary + the formatted duration ("Pensó durante 12 s"), expandable
 *     with a click.
 *
 * Theme-safe: only token classes (bg-background / border-border /
 * text-muted-foreground…), mirroring agentic-steps.tsx. Strings come from
 * the `thinking` next-intl namespace (es/en seeds + 57 generated locales,
 * English deep-merge fallback covers any gap).
 */

import React, { useEffect, useMemo, useRef, useState } from "react"
import clsx from "clsx"
import { ChevronDown, ChevronRight, Brain, Globe, FileText, Terminal, Wrench, Image as ImageIcon } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useTranslations } from "next-intl"
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-sanitize"
import { DotmCircular15, THINKING_GLYPH_COLOR } from "@/components/ui/dotm-circular-15"
import { CustomCodeBlock } from "@/components/ui/custom-code-block"

export type ThinkingToolCall = {
  index: number
  name?: string
  /** Accumulated (possibly partial) JSON arguments. */
  args?: string
}

export type ThinkingTraceProps = {
  /** Chain-of-thought text (markdown), partial while streaming. */
  reasoning: string
  /** True while reasoning deltas are still arriving. */
  streaming: boolean
  /** Total thinking duration in ms (from reasoning_done / persisted metadata). */
  durationMs?: number | null
  /** Tool calls interleaved in the thinking phase, in arrival order. */
  toolCalls?: ThinkingToolCall[]
}

export function formatThinkingDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`
}

/** First sentence (or first line) of the reasoning, for the collapsed summary. */
export function firstReasoningSentence(reasoning: string): string {
  const clean = (reasoning || "")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return ""
  const match = clean.match(/^.*?[.!?…](?:\s|$)/)
  const sentence = (match ? match[0] : clean).trim()
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence
}

function toolIconFor(name?: string) {
  const n = String(name || "").toLowerCase()
  const cls = "h-3.5 w-3.5"
  if (/search|browse|web|url|read/.test(n)) return <Globe className={cls} />
  if (/doc|file|pdf|rag/.test(n)) return <FileText className={cls} />
  if (/bash|exec|code|python|terminal|run/.test(n)) return <Terminal className={cls} />
  if (/image|chart|diagram|video|svg/.test(n)) return <ImageIcon className={cls} />
  return <Wrench className={cls} />
}

function describeToolCall(name: string | undefined, t: ReturnType<typeof useTranslations>): string {
  const n = String(name || "").toLowerCase()
  if (/search/.test(n)) return t("toolSearching")
  if (/read|url|browse/.test(n)) return t("toolReading")
  if (/bash|exec|code|python|run/.test(n)) return t("toolRunning")
  return t("toolUsing", { name: name || "tool" })
}

function ToolCallRow({ call }: { call: ThinkingToolCall }) {
  const t = useTranslations("thinking")
  const [open, setOpen] = useState(false)
  const prettyArgs = useMemo(() => {
    const raw = (call.args || "").trim()
    if (!raw) return ""
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw // partial JSON while still streaming — show as-is
    }
  }, [call.args])

  return (
    <div className="my-1.5 flex gap-2.5">
      <div className="flex w-5 shrink-0 justify-center text-muted-foreground">{toolIconFor(call.name)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-foreground/80">
            {describeToolCall(call.name, t)}
          </span>
          {call.name && (
            <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
              {call.name}
            </span>
          )}
          {prettyArgs && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-0.5 rounded-full border border-border/60 px-1.5 py-px text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t("arguments")}
            </button>
          )}
        </div>
        {open && prettyArgs && (
          <div className="mt-1.5 overflow-hidden rounded-lg text-[12px]">
            <CustomCodeBlock className="language-json">{prettyArgs}</CustomCodeBlock>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ThinkingTrace({ reasoning, streaming, durationMs, toolCalls }: ThinkingTraceProps) {
  const t = useTranslations("thinking")
  // Expanded by default while streaming; auto-collapses when the thinking
  // phase closes. The user's explicit toggle always wins afterwards.
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const expanded = userToggled !== null ? userToggled : streaming
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Internal auto-scroll anchored to the bottom while deltas arrive.
  useEffect(() => {
    if (!streaming || !expanded) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reasoning, streaming, expanded])

  const hasReasoning = Boolean((reasoning || "").trim()) || (toolCalls?.length ?? 0) > 0
  if (!hasReasoning && !streaming) return null

  const summary = firstReasoningSentence(reasoning)
  const headerLabel = streaming
    ? t("thinking")
    : durationMs && durationMs > 0
      ? t("thoughtFor", { duration: formatThinkingDuration(durationMs) })
      : t("thought")

  return (
    <div className="mb-2.5 w-full max-w-2xl">
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
        aria-label={t("reasoningAria")}
        className="group flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left"
      >
        {streaming ? (
          <DotmCircular15 size={18} color={THINKING_GLYPH_COLOR} className="shrink-0" ariaLabel={t("thinking")} />
        ) : (
          <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={clsx(
            "min-w-0 truncate text-[13px] font-medium tracking-tight",
            streaming
              ? // Animated gradient sweep across the label (globals.css).
                "thinking-shimmer-text"
              : "text-muted-foreground group-hover:text-foreground/80",
          )}
        >
          {headerLabel}
          {!streaming && !expanded && summary ? (
            <span className="ml-1.5 font-normal text-muted-foreground/70">· {summary}</span>
          ) : null}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        )}
      </button>

      {expanded && (
        <div className="mt-1 border-l border-border/50 pl-3">
          <div
            ref={scrollerRef}
            className={clsx(
              "overflow-y-auto pr-1 text-[13px] leading-relaxed text-muted-foreground",
              streaming ? "max-h-52" : "max-h-80",
            )}
          >
            {(reasoning || "").trim() && (
              <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-1.5 [&_pre]:my-2">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                  {reasoning}
                </ReactMarkdown>
              </div>
            )}
            {(toolCalls || []).map((call) => (
              <ToolCallRow key={call.index} call={call} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
