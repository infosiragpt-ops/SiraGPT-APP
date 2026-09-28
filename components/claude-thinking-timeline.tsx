"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import clsx from "clsx"
import { useLocale, useTranslations } from "next-intl"
import { ThinkingStatusLoader, announcementKey, useThrottledAnnouncement } from "@/components/thinking-status-loader"
import {
  LOADER_LABELS,
  formatThinkingElapsed,
  isTerminalLoaderState,
  loaderLabel,
  mapEventToLoaderState,
  type LoaderState,
} from "@/lib/thinking-loaders"
import { formatStepDuration, isGenericThinkingLabel, mentionsDuration } from "@/lib/chat/live-progress"

export const CLAUDE_THINK_ACTIVE = "var(--step-running)"
export const CLAUDE_THINK_DONE = "var(--step-done)"
export const CLAUDE_THINK_LINE = "hsl(var(--border))"
export const CLAUDE_THINK_FAILED = "var(--step-failed)"
export const CLAUDE_THINK_ERROR = CLAUDE_THINK_FAILED

/** Finished steps shown before «Ver N pasos anteriores». */
export const CLAUDE_TIMELINE_VISIBLE_TRAIL = 6

/**
 * Silence between phases on a live turn: for this long the header keeps the
 * step that just finished (the next phase usually begins within
 * milliseconds), then a generic «Pensando…» (the canned phrases) counts from
 * the moment the silence began. The header is never blank while live.
 */
export const THINKING_GAP_FILLER_MS = 600

export type ClaudeTimelineKind = "dot" | "terminal" | "document" | "image" | "sunburst" | "loader" | "check" | "cross"

export type ClaudeTimelineStep = {
  id: string
  label: string
  kind?: ClaudeTimelineKind
  status: "done" | "active" | "error"
  elapsedSec?: number | null
  /** Client epoch ms the step started: an active row counts its own seconds from it. */
  startedAt?: number
  /** One quiet line under the label: what exactly is happening / what it found. */
  note?: string
  /** How long a finished step took (shown right-aligned when there is no `meta`). */
  durationMs?: number
  expandable?: boolean
  details?: string
  // "prose" renders the details as muted paragraphs (live reasoning, Claude
  // style) instead of a monospace block; `defaultOpen` shows them unfolded
  // while the step is active so the user watches the thinking as it streams.
  detailsKind?: "code" | "prose"
  defaultOpen?: boolean
  tool?: string
  path?: string
  loaderState?: LoaderState
  /** Quiet right-aligned facts for a finished step, e.g. "8 fuentes · 180 ms". */
  meta?: string
  /** Sources a web search returned, rendered as favicon chips under the row. */
  sources?: Array<{ title?: string; url: string }>
}

/** One-line summary that replaces the full timeline (answer streaming / done). */
export type ClaudeTimelineCollapsed = {
  live: boolean
  label: string
  meta?: string
  startedAt?: number
  /**
   * What screen readers hear for a live line: stable text (no running
   * counts), so it is announced once when it appears — not on every tick.
   */
  announce?: string
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

const MAX_SOURCE_CHIPS = 5

function StepSources({ sources }: { sources: Array<{ title?: string; url: string }> }) {
  const chips = sources
    .map((source) => ({ ...source, domain: sourceDomain(source.url) }))
    .filter((source) => source.domain)
  if (!chips.length) return null
  const visible = chips.slice(0, MAX_SOURCE_CHIPS)
  const hidden = chips.length - visible.length
  return (
    <div data-step-sources="1" className="mb-1 ml-7 flex flex-wrap items-center gap-1.5">
      {visible.map((source, index) => (
        <a
          key={`${source.url}-${index}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.title || source.domain}
          className="inline-flex h-6 max-w-[11rem] items-center gap-1.5 rounded-full border border-border/60 bg-background/70 pl-1 pr-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- remote favicon, decorative */}
          <img
            src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(source.domain)}`}
            alt=""
            className="h-4 w-4 shrink-0 rounded-full"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
          <span className="truncate">{source.domain}</span>
        </a>
      ))}
      {hidden > 0 ? (
        <span className="inline-flex h-6 items-center rounded-full border border-border/60 px-2 text-[11.5px] tabular-nums text-muted-foreground">+{hidden}</span>
      ) : null}
    </div>
  )
}

/** «12 s» / «1 min 5 s» — same counter as the live header. */
export function formatClaudeElapsed(sec: number): string {
  return formatThinkingElapsed(sec)
}

export function inferClaudeKind(input: {
  tool?: string
  label?: string
  path?: string
  status?: ClaudeTimelineStep["status"]
}): ClaudeTimelineKind {
  if (input.status === "active") return "loader"
  const hay = [input.tool, input.label, input.path].filter(Boolean).join(" ").toLowerCase()
  const isImg = hay.includes("png") || hay.includes("jpg") || hay.includes("imagen")
  if (isImg || hay.includes("foto") || hay.includes("webp") || hay.includes("image")) return "image"
  const isDoc = hay.includes("leido") || hay.includes("leyendo") || hay.includes("archivo")
  if (isDoc || hay.includes("pdf") || hay.includes(".md") || hay.includes("fuente")) return "document"
  return "dot"
}

export function inferLoaderState(input: {
  tool?: string
  label?: string
  path?: string
  status?: ClaudeTimelineStep["status"]
  loaderState?: LoaderState
}): LoaderState {
  if (input.loaderState) return input.loaderState
  return mapEventToLoaderState({
    tool: input.tool,
    label: input.label,
    path: input.path,
    status: input.status === "error" ? "error" : input.status === "done" ? "done" : "running",
  })
}

/**
 * Glyph of a row once it has settled: a quiet check for every finished step
 * (reasoning keeps its dot, images keep their frame), a cross for a failure.
 */
function settledKind(step: ClaudeTimelineStep): ClaudeTimelineKind {
  if (step.status === "active") return step.kind || inferClaudeKind(step)
  if (step.status === "error") return "cross"
  if (step.detailsKind === "prose") return "dot"
  if (step.kind === "image") return "image"
  return "check"
}

/** Seconds an active row has been running: from its own start, else the caller's counter. */
function liveElapsedSec(step: ClaudeTimelineStep, now: number): number | null {
  if (step.status !== "active") return null
  if (typeof step.startedAt === "number" && Number.isFinite(step.startedAt)) {
    return Math.max(0, Math.floor((now - step.startedAt) / 1000))
  }
  return typeof step.elapsedSec === "number" && step.elapsedSec >= 0 ? step.elapsedSec : null
}

function TerminalIcon({ color }: { color: string }) {
  return (
    <span className="claude-think-terminal select-none font-mono leading-none" style={{ color, fontSize: 10, letterSpacing: "-0.04em" }} aria-hidden="true">
      {">_"}
    </span>
  )
}

function DocumentIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M4.2 1.6h5.1L12 4.4v9.8H4.2V1.6z" fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M9.2 1.7v2.9H12" fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M6 8h4.2M6 10.3h3.2" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}

function ImageIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.6" fill="none" stroke={color} strokeWidth="1.25" />
      <path d="M2.4 11.6 6 7.6l2.4 2.5 2-2.2 3.2 3.7" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="5.1" cy="5.6" r="1.05" fill={color} />
    </svg>
  )
}

function DotIcon({ color }: { color: string }) {
  return <span className="block h-[7px] w-[7px] rounded-full" style={{ background: color }} aria-hidden="true" />
}

function CheckIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style={{ color }}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style={{ color }}>
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function ClaudeStepIcon({
  kind,
  color,
  loaderState,
}: {
  kind: ClaudeTimelineKind
  color: string
  loaderState?: LoaderState
}) {
  // Live Pensando / tool hops always use the Luis kit SVG. `sunburst` is
  // kept as a kind alias so older traces still resolve to the bouncing bars.
  if (kind === "sunburst" || kind === "loader") {
    return (
      <ThinkingStatusLoader
        as="span"
        state={loaderState || "pensando"}
        hideLabel
        compact
        density="glyph"
        announce={false}
      />
    )
  }
  if (kind === "check") return <CheckIcon color={color} />
  if (kind === "cross") return <CrossIcon color={color} />
  if (kind === "terminal") return <TerminalIcon color={color} />
  if (kind === "document") return <DocumentIcon color={color} />
  if (kind === "image") return <ImageIcon color={color} />
  return <DotIcon color={color} />
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg className={clsx("think-chevron shrink-0", className)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One quiet line under a label — a block `span`, valid inside `<summary>`. */
function StepNote({ text, className, hidden }: { text: string; className?: string; hidden?: boolean }) {
  return (
    <span
      data-step-note="1"
      aria-hidden={hidden ? true : undefined}
      className={clsx("block truncate font-sans text-[12px] leading-4 tracking-[-0.005em] text-[var(--think-dim)]", className)}
    >
      {text}
    </span>
  )
}

function StepRow({ step: input, isLast, now, locale }: { step: ClaudeTimelineStep; isLast: boolean; now: number; locale?: string }) {
  // A finished step without explicit facts shows how long it took — unless
  // its label / note already says it («… empezó a razonar · 3,2 s»).
  const took = input.status !== "active" && !input.meta && !mentionsDuration(input.label) && !mentionsDuration(input.note)
    ? formatStepDuration(input.durationMs, locale)
    : ""
  const step = took ? { ...input, meta: took } : input
  const [open, setOpen] = useState(Boolean(step.defaultOpen))
  const detailsRef = React.useRef<HTMLPreElement | null>(null)
  const active = step.status === "active"
  // Live reasoning keeps its tail in view while it streams.
  useEffect(() => {
    if (!open || !active || !detailsRef.current) return
    detailsRef.current.scrollTop = detailsRef.current.scrollHeight
  }, [open, active, step.details])
  const color = step.status === "error" ? CLAUDE_THINK_FAILED : active ? CLAUDE_THINK_ACTIVE : CLAUDE_THINK_DONE
  const kind = settledKind(step)
  const loaderState = inferLoaderState(step)
  const needsEllipsis = active && !step.label.endsWith("...") && !step.label.endsWith("…")
  const label = needsEllipsis ? step.label + "…" : step.label
  const elapsedSec = liveElapsedSec(step, now)
  const elapsed = active && typeof elapsedSec === "number" && elapsedSec >= 0 ? formatClaudeElapsed(elapsedSec) : null
  const glyph = <ClaudeStepIcon kind={kind} color={color} loaderState={loaderState} />
  const note = step.note ? step.note.trim() : ""
  return (
    <div className={clsx("claude-think-row relative", active && "claude-think-row--active")} data-step-status={step.status}>
      {!isLast && (
        <span aria-hidden className="claude-think-rail pointer-events-none absolute left-[9.5px] top-[20px] bottom-0 w-px" style={{ background: CLAUDE_THINK_LINE }} />
      )}
      <div className="flex w-full items-center gap-2 py-[5px]" style={{ color }}>
        {step.expandable && step.details ? (
          <details className="min-w-0 flex-1" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
            <summary className="flex min-w-0 cursor-pointer list-none flex-col text-left" style={{ color }}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center bg-background" data-kind={kind} data-loader={loaderState}>{glyph}</span>
                <Chevron className="h-3 w-3" />
                <span className="min-w-0 flex-1 truncate font-sans text-[13px] leading-5 tracking-[-0.01em]">{label}</span>
                {elapsed ? <span aria-hidden="true" className="claude-think-elapsed ml-3 shrink-0 font-sans text-[12.5px] tabular-nums leading-5">{elapsed}</span> : null}
                {!elapsed && step.meta ? <span data-step-meta="1" className="ml-3 shrink-0 font-sans text-[12px] tabular-nums leading-5 text-[var(--think-dim)]">{step.meta}</span> : null}
              </span>
              {note ? <StepNote text={note} className="ml-12 -mt-px" hidden={active} /> : null}
            </summary>
            {step.detailsKind === "prose" ? (
              <pre
                ref={detailsRef}
                data-thinking-prose="1"
                aria-live="off"
                className="claude-think-prose mb-1.5 ml-10 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l border-border/60 pl-3 font-sans text-[13px] leading-5 text-muted-foreground"
              >
                {step.details}
              </pre>
            ) : (
              <pre ref={detailsRef} className="mb-1.5 ml-10 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">{step.details}</pre>
            )}
          </details>
        ) : (
          <>
            <span className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center bg-background" data-kind={kind} data-loader={loaderState}>{glyph}</span>
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] leading-5 tracking-[-0.01em]">{label}</span>
            {elapsed ? <span aria-hidden="true" className="claude-think-elapsed ml-3 shrink-0 font-sans text-[12.5px] tabular-nums leading-5">{elapsed}</span> : null}
            {!elapsed && step.meta ? <span data-step-meta="1" className="ml-3 shrink-0 font-sans text-[12px] tabular-nums leading-5 text-[var(--think-dim)]">{step.meta}</span> : null}
          </>
        )}
      </div>
      {note && !(step.expandable && step.details) ? <StepNote text={note} className="-mt-1 mb-0.5 ml-7" hidden={active} /> : null}
      {step.sources?.length ? <StepSources sources={step.sources} /> : null}
    </div>
  )
}

/**
 * The live model reasoning under the current step: folded by default (the
 * note above already carries its latest line), one click shows the prose
 * with its tail in view.
 */
function HeaderProse({ text, className }: { text: string; className?: string }) {
  const t = useTranslations("thinking")
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLPreElement | null>(null)
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [open, text])
  return (
    <div className={clsx("mt-0.5", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="think-row inline-flex items-center gap-1 bg-transparent py-0.5 font-sans text-[12px] leading-4 text-[var(--think-dim)] transition-colors hover:text-[var(--think-text)]"
      >
        <Chevron className="h-2.5 w-2.5" />
        <span>{open ? t("hideReasoning") : t("showReasoning")}</span>
      </button>
      {open ? (
        <pre
          ref={ref}
          data-thinking-prose="1"
          aria-live="off"
          className="claude-think-prose mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l border-border/60 pl-3 font-sans text-[13px] leading-5 text-muted-foreground"
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}

/** Wall clock that ticks once per second while `enabled` (one interval per timeline). */
export function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return now
}

/**
 * Client time a key was first seen — per-step start for sources that carry no
 * timestamp (tool calls, agent steps). Stable across re-renders.
 */
export function useFirstSeenClock(): (key: string) => number {
  const seen = useRef<Map<string, number>>(new Map())
  return React.useCallback((key: string) => {
    const known = seen.current.get(key)
    if (typeof known === "number") return known
    const at = Date.now()
    seen.current.set(key, at)
    return at
  }, [])
}

/** `value`, updated at most once every `ms` (leading + trailing edge). */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const lastAt = useRef(0)
  useEffect(() => {
    if (Object.is(value, shown)) return
    const wait = Math.max(0, lastAt.current + ms - Date.now())
    const id = window.setTimeout(() => {
      lastAt.current = Date.now()
      setShown(value)
    }, wait)
    return () => window.clearTimeout(id)
  }, [value, shown, ms])
  return shown
}

type TimelineHeader = {
  state: LoaderState
  /** Explicit label; undefined lets a bare «Pensando…» rotate its fallback phrases. */
  label?: string
  elapsedSec: number | null
  note: string
  /** Something is still happening (a running step, the grace or the gap filler). */
  live: boolean
}

export function ClaudeThinkingTimeline({
  steps,
  className,
  compact,
  collapsed,
  live = false,
}: {
  steps: ClaudeTimelineStep[]
  className?: string
  compact?: boolean
  /** One quiet line (answer streaming / done); the steps open behind its chevron. */
  collapsed?: ClaudeTimelineCollapsed | null
  /**
   * The turn is still running: when no step is active the header keeps the
   * step that just finished, then a generic «Pensando…» — never blank.
   */
  live?: boolean
}) {
  const t = useTranslations("thinking")
  const locale = useLocale()
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const visible = useMemo(() => steps.filter((s) => (s.label || "").trim()), [steps])
  // The current step is the newest one still running; a failure only takes
  // the header while it is the latest thing that happened.
  const current = useMemo(() => {
    if (collapsed) return null
    for (let i = visible.length - 1; i >= 0; i -= 1) if (visible[i].status === "active") return visible[i]
    const last = visible[visible.length - 1]
    return last && last.status === "error" ? last : null
  }, [visible, collapsed])

  // Silence between phases: the moment it began (a ref, so the very render
  // that loses the running step already has a header — no blank frame).
  const idle = Boolean(live) && !collapsed && !current
  const gapStartRef = useRef<number | null>(null)
  if (!idle) gapStartRef.current = null
  else if (gapStartRef.current === null) gapStartRef.current = Date.now()
  const gapStart = gapStartRef.current
  const [graceOverFor, setGraceOverFor] = useState<number | null>(null)
  useEffect(() => {
    if (gapStart === null) return
    const id = window.setTimeout(() => setGraceOverFor(gapStart), Math.max(0, gapStart + THINKING_GAP_FILLER_MS - Date.now()))
    return () => window.clearTimeout(id)
  }, [gapStart])
  const inGrace = gapStart !== null && graceOverFor !== gapStart
  const lastRow = visible[visible.length - 1]
  // Through the grace the step that just finished keeps the header, so a
  // back-to-back phase change never blinks (reasoning prose excluded).
  const graceRow = inGrace && lastRow && lastRow.status === "done" && lastRow.detailsKind !== "prose" ? lastRow : null

  const ticking = Boolean(
    (collapsed && collapsed.live && typeof collapsed.startedAt === "number")
      || gapStart !== null
      || visible.some((s) => s.status === "active" && typeof s.startedAt === "number"),
  )
  const now = useNowTick(ticking)

  let header: TimelineHeader | null = null
  if (current) {
    // A real label always wins; a bare «Pensando…» with a live note (the
    // model's current line of thought) is shown as-is too, so the fallback
    // phrases never rotate over real reasoning.
    header = {
      state: current.status === "error" ? "error" : inferLoaderState(current),
      label: current.note || !isGenericThinkingLabel(current.label) ? current.label : undefined,
      elapsedSec: liveElapsedSec(current, now),
      note: (current.note || "").trim(),
      live: current.status === "active",
    }
  } else if (graceRow) {
    const inferred = inferLoaderState({ tool: graceRow.tool, label: graceRow.label, path: graceRow.path, status: "active" })
    header = {
      state: isTerminalLoaderState(inferred) ? "pensando" : inferred,
      label: graceRow.label,
      // Frozen at what the step measured — it no longer runs.
      elapsedSec: typeof graceRow.durationMs === "number" && graceRow.durationMs >= 0 ? Math.floor(graceRow.durationMs / 1000) : null,
      note: (graceRow.note || "").trim(),
      live: true,
    }
  } else if (gapStart !== null) {
    header = {
      state: "pensando",
      // Steady through the grace; the canned phrases only after it.
      label: inGrace ? LOADER_LABELS.pensando : undefined,
      elapsedSec: Math.max(0, Math.floor((now - gapStart) / 1000)),
      note: "",
      live: true,
    }
  }
  const headerRowId = current?.id ?? graceRow?.id ?? null
  const trail = useMemo(
    () => (headerRowId ? visible.filter((s) => s.id !== headerRowId) : visible),
    [visible, headerRowId],
  )
  // Once a live note has shown, its line stays reserved while the header is
  // live, so the trail never jumps when a phase with / without a note swaps in.
  const noteSeenRef = useRef(false)
  if (header && header.live && header.note) noteSeenRef.current = true
  const reserveNote = Boolean(header && header.live && noteSeenRef.current)

  // Screen readers get one throttled live region: a new step (label / note)
  // right away, ticking seconds only every ~10 s; a live collapsed line is
  // stable text (announced when it appears, then on completion). The visual
  // chips are silent and the trail is not a live region, so expanding it or
  // a step settling is never read out.
  const announceLive = Boolean((collapsed && collapsed.live) || (!collapsed && header && header.live))
  const announceText = collapsed
    ? collapsed.live
      ? (collapsed.announce || collapsed.label)
      : [collapsed.label, collapsed.meta].filter(Boolean).join(" · ")
    : header
      ? [
        header.label || loaderLabel(header.state),
        header.note,
        header.live && header.elapsedSec !== null ? formatClaudeElapsed(header.elapsedSec) : "",
      ].filter(Boolean).join(" · ")
      : ""
  const announceStepKey = collapsed
    ? announcementKey(announceText)
    : header
      ? announcementKey(`${header.label || loaderLabel(header.state)} ${header.note}`)
      : ""
  const announced = useThrottledAnnouncement(announceText, announceLive, announceStepKey)

  if (!visible.length && !collapsed && !header) return null

  const liveRegion = (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-thinking-announce="timeline">
      {announced}
    </span>
  )
  const hiddenCount = showAll ? 0 : Math.max(0, trail.length - CLAUDE_TIMELINE_VISIBLE_TRAIL)
  const shownTrail = hiddenCount ? trail.slice(hiddenCount) : trail
  const trailRows = (
    <>
      {hiddenCount > 0 ? (
        <button
          type="button"
          data-step-earlier="1"
          onClick={() => setShowAll(true)}
          className="think-row ml-7 bg-transparent py-0.5 text-left font-sans text-[12px] leading-5 text-[var(--think-dim)] transition-colors hover:text-[var(--think-text)]"
        >
          {t("earlierSteps", { count: hiddenCount })}
        </button>
      ) : null}
      {shownTrail.map((step, i) => (
        <StepRow key={step.id} step={step} isLast={i === shownTrail.length - 1} now={now} locale={locale} />
      ))}
    </>
  )

  if (collapsed) {
    const collapsedElapsed = collapsed.live && typeof collapsed.startedAt === "number"
      ? Math.max(0, Math.floor((now - collapsed.startedAt) / 1000))
      : null
    return (
      <div
        data-claude-thinking="1"
        data-thinking-collapsed={collapsed.live ? "live" : "done"}
        className={clsx("claude-thinking-timeline w-full max-w-2xl font-sans", compact ? "my-1.5" : "my-2", className)}
      >
        {liveRegion}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={visible.length ? expanded : undefined}
          aria-label={collapsed.live ? collapsed.label : undefined}
          disabled={!visible.length}
          className="think-row group flex w-full min-w-0 items-center gap-2 bg-transparent py-[3px] text-left disabled:cursor-default"
        >
          {collapsed.live ? (
            <ThinkingStatusLoader
              as="span"
              state="pensando"
              label={collapsed.label}
              elapsedSec={collapsedElapsed}
              compact={compact}
              announce={false}
              silent
              className="min-w-0 tabular-nums"
            />
          ) : (
            <span className="inline-flex min-w-0 items-center gap-2.5" style={{ color: CLAUDE_THINK_DONE }}>
              <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center" data-kind="check" aria-hidden="true">
                <CheckIcon color={CLAUDE_THINK_DONE} />
              </span>
              <span className="min-w-0 truncate font-sans text-[13px] leading-5 tracking-[-0.01em]">{collapsed.label}</span>
              {collapsed.meta ? (
                <span data-step-meta="1" className="-ml-1 shrink-0 font-sans text-[12px] tabular-nums leading-5 text-[var(--think-dim)]">· {collapsed.meta}</span>
              ) : null}
            </span>
          )}
          {visible.length ? <Chevron className="h-3 w-3 text-[var(--think-dim)] opacity-70 transition-opacity group-hover:opacity-100" /> : null}
        </button>
        {expanded && visible.length ? <div className="mt-0.5">{trailRows}</div> : null}
      </div>
    )
  }

  const noteIndent = compact ? "ml-9" : "ml-8"
  return (
    <div data-claude-thinking="1" className={clsx("claude-thinking-timeline w-full max-w-2xl font-sans", compact ? "my-1.5" : "my-2.5", className)}>
      {liveRegion}
      {header ? (
        <div
          data-step-current="1"
          data-step-grace={!current && graceRow ? "1" : undefined}
          data-step-gap={!current && !graceRow ? "1" : undefined}
          className="mb-1 min-w-0"
        >
          <ThinkingStatusLoader
            state={header.state}
            label={header.label}
            elapsedSec={header.elapsedSec}
            compact={compact}
            announce={false}
            silent
            className="max-w-full"
          />
          {header.note ? (
            <StepNote text={header.note} className={noteIndent} hidden={header.live} />
          ) : reserveNote ? (
            <span aria-hidden="true" data-step-note-slot="1" className={clsx("block min-h-4", noteIndent)} />
          ) : null}
          {current && current.detailsKind === "prose" && current.details ? <HeaderProse key={current.id} text={current.details} className={noteIndent} /> : null}
          {current?.sources?.length ? <StepSources sources={current.sources} /> : null}
        </div>
      ) : null}
      {trailRows}
    </div>
  )
}

export function useClaudeElapsedSec(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) return
    const started = Date.now()
    setElapsed(0)
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [running])
  return elapsed
}
