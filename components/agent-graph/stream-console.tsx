"use client"

/**
 * StreamConsole — scrolling log of raw agent events, for debugging.
 *
 * Not a first-class part of the UI but useful: agents frequently
 * surface issues that the structured plan graph hides (e.g. a
 * capability denied by policy, a retry, an unusual stopped reason).
 * Showing the raw SSE stream alongside the graph lets power users
 * diagnose quickly without diving into server logs.
 *
 * Auto-scrolls to bottom on new events — opt out by manually
 * scrolling up (we detect scroll position and only auto-scroll when
 * the user is already pinned near the bottom). This mirrors how
 * every modern terminal UI handles log tailing.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

export interface ConsoleEntry {
  at: number
  type: string
  label: string
  detail?: string
}

interface Props {
  entries: ConsoleEntry[]
  className?: string
}

const STICK_THRESHOLD = 80 // px from bottom; within this we keep autoscrolling

export function StreamConsole({ entries, className }: Props) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pinnedRef = React.useRef(true)

  // Track whether the user is scrolled to (or near) the bottom.
  // If they scroll up, stop auto-scrolling so we don't fight them.
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distanceFromBottom < STICK_THRESHOLD
  }, [])

  React.useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-muted/20 overflow-hidden flex flex-col",
        className,
      )}
    >
      <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        Event stream
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed space-y-0.5"
      >
        {entries.length === 0 ? (
          <div className="text-muted-foreground/60">— no events yet —</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-muted-foreground/50 tabular-nums w-14 shrink-0">
                {formatTime(e.at)}
              </span>
              <span className={cn("w-20 shrink-0 uppercase", typeColor(e.type))}>
                {e.type}
              </span>
              <span className="min-w-0 flex-1 text-foreground/85 truncate">
                {e.label}
                {e.detail && (
                  <span className="text-muted-foreground/70"> · {e.detail}</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function formatTime(ts: number) {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0")
}

function typeColor(t: string) {
  switch (t) {
    case "plan": case "replan": return "text-amber-600 dark:text-amber-400"
    case "step": return "text-sky-600 dark:text-sky-400"
    case "synthesis": return "text-purple-600 dark:text-purple-400"
    case "final": return "text-emerald-600 dark:text-emerald-400"
    case "error": return "text-red-600 dark:text-red-400"
    case "policy": return "text-muted-foreground"
    default: return "text-foreground/70"
  }
}
