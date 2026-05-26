"use client"

/**
 * PhaseTimeline — animated vertical rail of the 4 pipeline phases
 * (search / validate / synthesize / format) with per-phase status
 * and a running detail line.
 *
 * Framer Motion handles the state transitions: a phase that flips
 * from 'pending' → 'running' fades in a pulsing dot; running → done
 * pops a check mark. The rail between phases fills as each
 * completes. Animation is modest (180ms) so the eye can keep up
 * with a 10-source validate that takes 3 seconds total.
 */

import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Check, AlertCircle, Circle } from "lucide-react"
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export type PhaseKey = "search" | "validate" | "synthesize" | "format"
export type PhaseStatus = "pending" | "running" | "done" | "error"

export interface PhaseState {
  status: PhaseStatus
  detail?: string
  error?: string
}

interface Props {
  phases: Record<PhaseKey, PhaseState>
  labels: Record<PhaseKey, string>
}

const ORDER: PhaseKey[] = ["search", "validate", "synthesize", "format"]

export function PhaseTimeline({ phases, labels }: Props) {
  return (
    <ol className="relative space-y-4">
      {ORDER.map((key, i) => {
        const state = phases[key]
        const next = i < ORDER.length - 1
        return (
          <li key={key} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <PhaseIcon status={state.status} />
              {next && (
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 h-8 w-px transition-colors duration-300",
                    state.status === "done" ? "bg-foreground/40" : "bg-border",
                  )}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className={cn(
                "text-sm font-medium transition-colors",
                state.status === "pending" ? "text-muted-foreground" : "text-foreground",
              )}>
                {labels[key]}
              </div>
              <AnimatePresence mode="wait">
                {state.detail && (
                  <motion.div
                    key={state.detail}
                    initial={{ opacity: 0, y: -2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 2 }}
                    transition={{ duration: 0.18 }}
                    className="text-xs text-muted-foreground mt-0.5"
                  >
                    {state.detail}
                  </motion.div>
                )}
              </AnimatePresence>
              {state.error && (
                <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                  {state.error}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function PhaseIcon({ status }: { status: PhaseStatus }) {
  const base = "h-5 w-5 rounded-full flex items-center justify-center shrink-0"
  if (status === "done") {
    return (
      <motion.span
        key="done"
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 20 }}
        className={cn(base, "bg-foreground text-background")}
      >
        <Check className="h-3 w-3" />
      </motion.span>
    )
  }
  if (status === "running") {
    return (
      <span className={cn(base, "text-foreground")}>
        <ThinkingIndicator size="sm" />
      </span>
    )
  }
  if (status === "error") {
    return (
      <span className={cn(base, "text-red-500")}>
        <AlertCircle className="h-4 w-4" />
      </span>
    )
  }
  return (
    <span className={cn(base, "text-muted-foreground/50")}>
      <Circle className="h-3 w-3" />
    </span>
  )
}
