"use client"

import React, { useEffect, useMemo, useState } from "react"
import clsx from "clsx"
import { ThinkingStatusLoader } from "@/components/thinking-status-loader"
import { mapEventToLoaderState, type LoaderState } from "@/lib/thinking-loaders"

export const CLAUDE_THINK_ACTIVE = "var(--step-running)"
export const CLAUDE_THINK_DONE = "var(--step-done)"
export const CLAUDE_THINK_LINE = "rgba(0,0,0,0.10)"
export const CLAUDE_THINK_FAILED = "var(--step-failed)"
export const CLAUDE_THINK_ERROR = CLAUDE_THINK_FAILED

export type ClaudeTimelineKind = "dot" | "terminal" | "document" | "image" | "sunburst" | "loader"

export type ClaudeTimelineStep = {
  id: string
  label: string
  kind?: ClaudeTimelineKind
  status: "done" | "active" | "error"
  elapsedSec?: number | null
  expandable?: boolean
  details?: string
  tool?: string
  path?: string
  loaderState?: LoaderState
}

export function formatClaudeElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
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

function SunburstIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="claude-think-sunburst animate-spin" style={{ animationDuration: "1.15s" }} aria-hidden="true">
      <g fill={color}>
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(0 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(45 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(90 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(135 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(180 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(225 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(270 8 8)" />
        <rect x="7.15" y="0.6" width="1.7" height="4.2" rx="0.7" transform="rotate(315 8 8)" />
      </g>
    </svg>
  )
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

export function ClaudeStepIcon({ kind, color }: { kind: ClaudeTimelineKind; color: string }) {
  if (kind === "sunburst" || kind === "loader") return <SunburstIcon color={color} />
  if (kind === "terminal") return <TerminalIcon color={color} />
  if (kind === "document") return <DocumentIcon color={color} />
  if (kind === "image") return <ImageIcon color={color} />
  return <DotIcon color={color} />
}

function StepRow({ step, isLast }: { step: ClaudeTimelineStep; isLast: boolean }) {
  const [open, setOpen] = useState(false)
  const active = step.status === "active"
  const color = step.status === "error" ? CLAUDE_THINK_FAILED : active ? CLAUDE_THINK_ACTIVE : CLAUDE_THINK_DONE
  const kind = step.kind || inferClaudeKind(step)
  const loaderState = inferLoaderState(step)
  const needsEllipsis = active && !step.label.endsWith("...") && !step.label.endsWith("…")
  const label = needsEllipsis ? step.label + "…" : step.label
  const elapsed = active && typeof step.elapsedSec === "number" && step.elapsedSec >= 0 ? formatClaudeElapsed(step.elapsedSec) : null
  const glyph = <ClaudeStepIcon kind={kind} color={color} />
  return (
    <div className={clsx("claude-think-row relative", active && "claude-think-row--active")}>
      {!isLast && (
        <span aria-hidden className="claude-think-rail pointer-events-none absolute left-[9.5px] top-[20px] bottom-0 w-px" style={{ background: CLAUDE_THINK_LINE }} />
      )}
      <div className="flex w-full items-center gap-2 py-[5px]" style={{ color }}>
        {step.expandable && step.details ? (
          <details className="min-w-0 flex-1" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 text-left" style={{ color }}>
              <span className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center bg-background" data-kind={kind} data-loader={loaderState}>{glyph}</span>
              <svg className="think-chevron h-3 w-3 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] leading-5 tracking-[-0.01em]">{label}</span>
              {elapsed ? <span className="claude-think-elapsed ml-3 shrink-0 font-sans text-[12.5px] tabular-nums leading-5">{elapsed}</span> : null}
            </summary>
            <pre className="mb-1.5 ml-10 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">{step.details}</pre>
          </details>
        ) : (
          <>
            <span className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center bg-background" data-kind={kind} data-loader={loaderState}>{glyph}</span>
            <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] leading-5 tracking-[-0.01em]">{label}</span>
            {elapsed ? <span className="claude-think-elapsed ml-3 shrink-0 font-sans text-[12.5px] tabular-nums leading-5">{elapsed}</span> : null}
          </>
        )}
      </div>
    </div>
  )
}

export function ClaudeThinkingTimeline({ steps, className, compact }: { steps: ClaudeTimelineStep[]; className?: string; compact?: boolean }) {
  const visible = useMemo(() => steps.filter((s) => (s.label || "").trim()), [steps])
  const current = useMemo(
    () => visible.find((s) => s.status === "active") || visible.find((s) => s.status === "error") || null,
    [visible],
  )
  const headerState = current
    ? current.status === "error"
      ? "error"
      : inferLoaderState(current)
    : null
  const trail = useMemo(
    () => (current ? visible.filter((s) => s.id !== current.id) : visible),
    [visible, current],
  )
  if (!visible.length) return null
  return (
    <div role="status" aria-live="polite" data-claude-thinking="1" className={clsx("claude-thinking-timeline w-full max-w-2xl font-sans", compact ? "my-1.5" : "my-2.5", className)}>
      {headerState && current ? (
        <ThinkingStatusLoader
          state={headerState}
          label={current.label}
          elapsedSec={current.elapsedSec}
          compact={compact}
          announce={false}
          className="mb-1"
        />
      ) : null}
      {trail.map((step, i) => (
        <StepRow key={step.id} step={step} isLast={i === trail.length - 1 && !current} />
      ))}
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
