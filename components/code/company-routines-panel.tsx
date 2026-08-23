"use client"

import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { coworkApi, type ScheduledCoworkTask } from "@/lib/cowork-api"
import {
  DEFAULT_EMPRESAS_ROUTINES,
  formatScheduleEsPE,
} from "@/lib/format-schedule-es-pe"
import { getActiveDepartmentSelection } from "@/lib/code-workspace-context"

export type CompanyRoutinesPanelProps = {
  className?: string
}

type RoutineRow = {
  id: string
  title: string
  schedule: string
}

function rowsFromTasks(tasks: ScheduledCoworkTask[]): RoutineRow[] {
  return tasks.map((task) => ({
    id: task.id,
    title: String(task.prompt || "Rutina").trim() || "Rutina",
    schedule: formatScheduleEsPE(task.cronExpr),
  }))
}

export function CompanyRoutinesPanel({ className }: CompanyRoutinesPanelProps) {
  const [rows, setRows] = React.useState<RoutineRow[]>(() =>
    DEFAULT_EMPRESAS_ROUTINES.map((routine) => ({
      id: routine.id,
      title: routine.title,
      schedule: formatScheduleEsPE(routine.cronExpr),
    })),
  )

  React.useEffect(() => {
    let cancelled = false
    const workspaceId =
      getActiveDepartmentSelection()?.projectId ||
      (typeof window !== "undefined" ? window.localStorage.getItem("code-workspace:active-folder") : null)
    if (!workspaceId) return
    void coworkApi
      .listScheduledTasks(workspaceId)
      .then((result) => {
        if (cancelled) return
        const tasks = Array.isArray(result?.tasks) ? result.tasks : []
        if (tasks.length > 0) setRows(rowsFromTasks(tasks))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section
      className={cn(
        "flex shrink-0 flex-col border-t border-border/60 bg-background",
        className,
      )}
      data-testid="company-routines-panel"
      aria-label="Rutinas"
    >
      <header className="flex h-9 items-center justify-between gap-2 px-3">
        <h2 className="text-[12px] font-semibold text-foreground">Rutinas</h2>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground active:bg-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Añadir rutina"
          title="Añadir rutina"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("siragpt:code-agent-request", {
                detail: { text: "Crea una rutina recurrente para este departamento." },
              }),
            )
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>
      <ul className="max-h-36 space-y-0.5 overflow-y-auto px-2 pb-2">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="flex min-h-11 w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/55 active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              aria-label={`${row.title}. ${row.schedule}`}
              title={`${row.title} — ${row.schedule}`}
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("siragpt:code-agent-request", {
                    detail: { text: `Ejecuta ahora la rutina: ${row.title}` },
                  }),
                )
              }}
            >
              <span className="text-[12px] font-medium leading-snug text-foreground">{row.title}</span>
              <span className="mt-0.5 text-[10px] text-muted-foreground">{row.schedule}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
