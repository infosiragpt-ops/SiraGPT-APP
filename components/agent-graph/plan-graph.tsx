"use client"

/**
 * PlanGraph — vertical chain of StepNodes connected by rails. The
 * rail between steps N and N+1 fills (changes color) once step N is
 * done, which gives a clean visual progression without needing an
 * SVG layer.
 *
 * Re-plans: when the executor invokes the planner mid-run, we keep
 * the already-done steps (they're still part of history) and append
 * the new plan tail. The node numbering continues so the user sees
 * "Step 3 re-planned → Step 4 new".
 */

import * as React from "react"
import { motion } from "framer-motion"

import { StepNode, type StepStatus, type StepTrace } from "./step-node"
import { cn } from "@/lib/utils"

export interface GraphStep {
  step: number
  goal: string
  tool_hint?: string | null
  status: StepStatus
  trace?: StepTrace
  error?: string
}

interface Props {
  steps: GraphStep[]
  compact?: boolean
}

export function PlanGraph({ steps, compact = false }: Props) {
  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 py-8 px-6 text-center text-sm text-muted-foreground">
        Waiting for plan…
      </div>
    )
  }
  return (
    <ol className={cn("relative", compact ? "space-y-2" : "space-y-3")}>
      {steps.map((s, i) => (
        <li key={`${s.step}-${i}`} className="relative">
          {/* Rail to the next step — animated fill once the current
              step is done. Hidden after the last item. */}
          {i < steps.length - 1 && (
            <motion.span
              aria-hidden
              className={cn(
                "absolute left-[19px] top-[44px] w-px transition-colors duration-300",
                s.status === "done" ? "bg-foreground/40" : "bg-border",
              )}
              initial={{ height: 0 }}
              animate={{ height: compact ? 16 : 20 }}
              transition={{ duration: 0.25, delay: 0.1 }}
            />
          )}
          <StepNode
            number={s.step}
            goal={s.goal}
            toolHint={s.tool_hint}
            status={s.status}
            trace={s.trace}
            error={s.error}
          />
        </li>
      ))}
    </ol>
  )
}
