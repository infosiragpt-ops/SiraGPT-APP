"use client"

/**
 * StepNode — single plan step rendered as a card in the vertical
 * graph. Status is reflected in the icon ring + background tint.
 *
 * Expandable: clicking the card toggles a trace pane showing the
 * ReAct thoughts and tool calls for that step. Collapsed by default
 * because a 5-step run with 3 tool calls each clutters the page
 * otherwise.
 */

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Check, Loader2, Circle, AlertCircle, ChevronDown, Wrench,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type StepStatus = "pending" | "running" | "done" | "error"

export interface StepTrace {
  thought?: string
  actions?: Array<{ tool: string; args: string; observation: unknown }>
}

interface Props {
  number: number
  goal: string
  toolHint?: string | null
  status: StepStatus
  trace?: StepTrace
  error?: string
}

const RING: Record<StepStatus, string> = {
  pending: "border-muted-foreground/30 bg-background text-muted-foreground/50",
  running: "border-foreground bg-background text-foreground",
  done:    "border-foreground bg-foreground text-background",
  error:   "border-red-500 bg-red-500/10 text-red-600",
}

export function StepNode({ number, goal, toolHint, status, trace, error }: Props) {
  const [open, setOpen] = React.useState(false)
  const hasTrace = !!(trace?.thought || (trace?.actions && trace.actions.length > 0))

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "rounded-xl border border-border/60 bg-card overflow-hidden transition-colors",
        status === "running" && "ring-2 ring-foreground/10",
        status === "error" && "border-red-500/40",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={!hasTrace}
        className={cn(
          "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors",
          hasTrace ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
        )}
      >
        <StatusDot number={number} status={status} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
              Step {number}
            </span>
            {toolHint && (
              <span className="inline-flex items-center gap-1 text-[10px] rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                <Wrench className="h-2.5 w-2.5" />
                {toolHint}
              </span>
            )}
          </div>
          <p className="text-sm font-medium mt-0.5 leading-snug">{goal}</p>
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>
          )}
        </div>

        {hasTrace && (
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground shrink-0 mt-0.5 transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasTrace && (
          <motion.div
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="border-t border-border/60"
          >
            <div className="px-4 py-3 space-y-2 bg-muted/30">
              {trace?.thought && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 mb-0.5">
                    Thought
                  </div>
                  <p className="text-xs text-foreground/85 leading-relaxed">
                    {trace.thought}
                  </p>
                </div>
              )}
              {trace?.actions && trace.actions.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 mb-0.5">
                    Tool calls
                  </div>
                  <ul className="space-y-1">
                    {trace.actions.map((a, i) => (
                      <li key={i} className="text-xs">
                        <span className="font-mono text-foreground/85">{a.tool}</span>
                        <span className="text-muted-foreground">
                          {" "}({truncate(a.args, 80)})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function StatusDot({ number, status }: { number: number; status: StepStatus }) {
  const base = "shrink-0 h-7 w-7 rounded-full border flex items-center justify-center text-xs font-medium"
  if (status === "done") {
    return (
      <motion.span
        key="done"
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 22 }}
        className={cn(base, RING.done)}
      >
        <Check className="h-3.5 w-3.5" />
      </motion.span>
    )
  }
  if (status === "running") {
    return (
      <span className={cn(base, RING.running)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    )
  }
  if (status === "error") {
    return (
      <span className={cn(base, RING.error)}>
        <AlertCircle className="h-3.5 w-3.5" />
      </span>
    )
  }
  return (
    <span className={cn(base, RING.pending)}>
      {number}
    </span>
  )
}

function truncate(s: string, max: number) {
  if (!s) return ""
  try {
    // Tool args are usually JSON — pretty-print for readability but
    // cap total length.
    const parsed = JSON.parse(s)
    const pretty = JSON.stringify(parsed)
    return pretty.length > max ? pretty.slice(0, max) + "…" : pretty
  } catch {
    return s.length > max ? s.slice(0, max) + "…" : s
  }
}
