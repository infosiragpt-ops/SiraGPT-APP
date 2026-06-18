"use client"

/**
 * PublishPipeline — animates the 5-step publish flow returned by
 * deploymentsApi.publish(): provision → security_scan → build → bundle → promote.
 *
 * The backend returns the phases already resolved (done/failed); we replay them
 * with a small stagger so the user sees the pipeline "run".
 */

import * as React from "react"
import { Check, Loader2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { PublishPhase } from "@/lib/deployments/deployments-api"

const STEP_ORDER = ["provision", "security_scan", "build", "bundle", "promote"] as const
type StepName = (typeof STEP_ORDER)[number]

const STEP_LABEL: Record<StepName, string> = {
  provision: "Provision",
  security_scan: "Security Scan",
  build: "Build",
  bundle: "Bundle",
  promote: "Promote",
}

type StepState = "pending" | "running" | "done" | "failed"

export function PublishPipeline({
  phases,
  onDone,
}: {
  phases: PublishPhase[]
  onDone?: () => void
}) {
  // Resolve each known step against the returned phases (order-independent).
  const phaseByName = React.useMemo(() => {
    const map = new Map<string, PublishPhase>()
    for (const phase of phases) map.set(phase.name, phase)
    return map
  }, [phases])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone

  React.useEffect(() => {
    setActiveIndex(0)
    let cancelled = false
    let index = 0
    const tick = () => {
      if (cancelled) return
      index += 1
      setActiveIndex(index)
      if (index >= STEP_ORDER.length) {
        window.setTimeout(() => {
          if (!cancelled) onDoneRef.current?.()
        }, 420)
        return
      }
      // Stop animating early if the current step failed.
      const step = STEP_ORDER[index - 1]
      if (phaseByName.get(step)?.status === "failed") return
      timer = window.setTimeout(tick, 520)
    }
    let timer = window.setTimeout(tick, 520)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [phaseByName])

  const stateFor = (index: number): StepState => {
    const step = STEP_ORDER[index]
    if (index < activeIndex) return phaseByName.get(step)?.status === "failed" ? "failed" : "done"
    if (index === activeIndex) return "running"
    return "pending"
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/80 p-4">
      <p className="mb-3 text-[12px] font-semibold text-foreground">Publishing…</p>
      <ol className="space-y-2">
        {STEP_ORDER.map((step, index) => {
          const state = stateFor(index)
          return (
            <li key={step} className="flex items-center gap-3">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]",
                  state === "done" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
                  state === "failed" && "border-rose-500/30 bg-rose-500/10 text-rose-600",
                  state === "running" && "border-amber-500/30 bg-amber-500/10 text-amber-600",
                  state === "pending" && "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                {state === "done" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : state === "failed" ? (
                  <X className="h-3.5 w-3.5" />
                ) : state === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-[12px]",
                  state === "pending" ? "text-muted-foreground" : "font-medium text-foreground",
                )}
              >
                {STEP_LABEL[step]}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
