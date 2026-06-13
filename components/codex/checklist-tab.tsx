"use client"

// codex/checklist-tab — the approved plan's tasks with coarse per-run status
// (feature 13): pending / in-progress (active run) / done (run done). Fine-
// grained per-task completion is noted as a future iteration.

import React from "react"
import clsx from "clsx"
import { Circle, CircleDot, CheckCircle2, ListChecks } from "lucide-react"
import type { TimelineState, TimelineItem } from "@/lib/codex/timeline-reducer"

type TaskStatus = "pending" | "in_progress" | "done"

function taskLabel(t: any): string {
  if (typeof t === "string") return t
  return t?.title || t?.name || String(t)
}

export function ChecklistTab({ state, runStatus }: { state: TimelineState; runStatus: string | null }) {
  const plan = state.items.find((i): i is Extract<TimelineItem, { kind: "plan" }> => i.kind === "plan")
  if (!plan || plan.tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
        <ListChecks className="h-6 w-6 opacity-50" />
        Aún no hay un plan aprobado con tareas.
      </div>
    )
  }

  const allDone = runStatus === "done"
  const active = runStatus != null && !["done", "error", "cancelled"].includes(runStatus)

  function statusFor(index: number): TaskStatus {
    if (allDone) return "done"
    if (active && index === 0) return "in_progress"
    return "pending"
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <ul className="space-y-1.5">
        {plan.tasks.map((t, i) => {
          const s = statusFor(i)
          const Icon = s === "done" ? CheckCircle2 : s === "in_progress" ? CircleDot : Circle
          return (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", s === "done" ? "text-emerald-400" : s === "in_progress" ? "text-violet-400" : "text-zinc-600")} />
              <span className={clsx(s === "done" ? "text-zinc-400 line-through" : "text-zinc-200")}>{taskLabel(t)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
