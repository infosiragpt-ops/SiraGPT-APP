"use client"

// codex/checklist-tab — the approved plan's tasks. When the agent reports real
// progress via update_plan (plan_updated events → state.planProgress) each task
// shows its REAL status (pending / in_progress / completed). When no progress
// has arrived (older runs, an agent that never calls update_plan) it degrades to
// the coarse per-run heuristic: pending / in-progress (active run) / done (run
// done) — so existing runs behave exactly as before.

import React from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { Circle, CircleDot, CheckCircle2, ListChecks } from "lucide-react"
import type { TimelineState, TimelineItem } from "@/lib/codex/timeline-reducer"

type TaskStatus = "pending" | "in_progress" | "done"

function taskLabel(task: any): string {
  if (typeof task === "string") return task
  return task?.title || task?.name || String(task)
}

function taskId(task: any, index: number): string {
  if (task && typeof task === "object" && typeof task.id === "string" && task.id) return task.id
  return `t${index + 1}`
}

export function ChecklistTab({ state, runStatus }: { state: TimelineState; runStatus: string | null }) {
  const t = useTranslations("codex")
  const plan = state.items.find((i): i is Extract<TimelineItem, { kind: "plan" }> => i.kind === "plan")
  if (!plan || plan.tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
        <ListChecks className="h-6 w-6 opacity-50" />
        {t("panel.checklistEmpty")}
      </div>
    )
  }

  const allDone = runStatus === "done"
  const active = runStatus != null && !["done", "error", "cancelled"].includes(runStatus)

  // Real per-task progress from update_plan, keyed by task id (title fallback).
  const progress = state.planProgress
  const byId = new Map<string, TaskStatus>()
  const byTitle = new Map<string, TaskStatus>()
  if (progress) {
    for (const p of progress) {
      const mapped: TaskStatus = p.status === "completed" ? "done" : p.status === "in_progress" ? "in_progress" : "pending"
      if (p.id) byId.set(p.id, mapped)
      if (p.title) byTitle.set(p.title, mapped)
    }
  }

  function statusFor(task: any, index: number): TaskStatus {
    if (progress) {
      // Real status wins. Match by id, then by title. A plan task the agent
      // never reported stays pending under real-progress mode.
      const real = byId.get(taskId(task, index)) ?? byTitle.get(taskLabel(task))
      return real ?? "pending"
    }
    // No progress reported → coarse run-status fallback (legacy behaviour).
    if (allDone) return "done"
    if (active && index === 0) return "in_progress"
    return "pending"
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <ul className="space-y-1.5">
        {plan.tasks.map((task, i) => {
          const s = statusFor(task, i)
          const Icon = s === "done" ? CheckCircle2 : s === "in_progress" ? CircleDot : Circle
          return (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", s === "done" ? "text-emerald-400" : s === "in_progress" ? "text-violet-400" : "text-zinc-600")} />
              <span className={clsx(s === "done" ? "text-zinc-400 line-through" : "text-zinc-200")}>{taskLabel(task)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
