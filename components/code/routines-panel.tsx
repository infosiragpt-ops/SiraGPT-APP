"use client"

/**
 * Rutinas — recurring scheduled work visible to the user, rendered under
 * the department computer pane in /code (founder visual target
 * 2026-08-22). Read/create/pause/resume/delete over /api/routines; the
 * durable execution engine is the backend scheduler (background-jobs
 * fleet owns firing + notifications).
 */

import * as React from "react"
import { CalendarClock, Loader2, PauseCircle, PlayCircle, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")

export type RoutineStatus = "idle" | "running" | "ok" | "error" | "disabled" | "skipped" | string

export type Routine = {
  id: string
  name: string | null
  cron: string | null
  timezone: string | null
  promptPreview: string
  enabled: boolean
  status: RoutineStatus
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: "ok" | "error" | null
  lastError: string | null
  lastRuns?: { at: string | null; ok: boolean; error?: string }[]
}

type RoutinesPanelProps = {
  className?: string
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** Compact human label for a cron expression: «cada 3h», «weekdays 9:32». */
function scheduleLabel(cron: string | null): string {
  if (!cron) return ""
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, , , dow] = parts

  const stepEvery = /^(?:\*\/(\d+)|0\s+\*\/(\d+)\s+\*\s+\*\s+\*)$/
  if (/^\*\/(\d+)$/.test(min) && hour === "*") {
    return `*/${RegExp.$1}`
  }
  if (/^\*\/(\d+)$/.test(hour) && min === "0") {
    return `cada ${RegExp.$1}h`
  }
  if (hour !== "*" && min !== "*" && dow === "1-5") {
    return `weekdays ${hour}:${min.padStart(2, "0")}`
  }
  if (hour !== "*" && min !== "*" && dow === "*") {
    return `diario ${hour}:${min.padStart(2, "0")}`
  }
  return cron
}

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(nextRunAt))
  } catch (_) {
    return nextRunAt
  }
}

const STATUS_DOT: Record<string, string> = {
  idle: "bg-zinc-400",
  running: "bg-blue-500 animate-pulse",
  ok: "bg-emerald-500",
  error: "bg-rose-500",
  disabled: "bg-zinc-500",
  skipped: "bg-amber-500",
}

export function RoutinesPanel({ className }: RoutinesPanelProps) {
  const t = useTranslations("code.routines")
  const [routines, setRoutines] = React.useState<Routine[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const res = await authenticatedFetch(`${API_BASE}/routines`, {
        credentials: "include",
        headers: authHeaders(),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message || body?.error || "list_failed")
      setRoutines(Array.isArray(body?.routines) ? body.routines : [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      setRoutines((prev) => prev ?? [])
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const mutate = React.useCallback(
    async (id: string, action: "pause" | "resume" | "delete") => {
      setBusyId(id)
      try {
        const res = await authenticatedFetch(
          `${API_BASE}/routines/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`,
          {
            method: action === "delete" ? "DELETE" : "POST",
            credentials: "include",
            headers: authHeaders(),
            signal: AbortSignal.timeout(20_000),
          },
        )
        if (!res.ok) throw new Error(`${action}_failed`)
        await load()
      } catch (_) {
        // keep panel alive on transient failures; list refresh shows truth
        void load()
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  return (
    <section
      className={cn("flex min-h-0 flex-col", className)}
      data-testid="routines-panel"
      data-routines-section="1"
      aria-label={t("title")}
    >
      <div className="flex items-center gap-2 border-b border-border/45 px-3 py-1.5">
        <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("title")}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-md"
          aria-label={t("refresh")}
          onClick={() => void load()}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px]">
              <Plus className="h-3 w-3" />
              {t("new")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <CreateRoutineForm
              onCreated={() => {
                setCreateOpen(false)
                void load()
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {routines == null ? (
        <div className="flex items-center justify-center py-4" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : routines.length === 0 ? (
        <p className="px-4 py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border/40 overflow-y-auto" data-testid="routines-list">
          {routines.map((routine) => (
            <li key={routine.id} className="flex items-center gap-2 px-3 py-2" data-testid="routine-row">
              <span
                aria-hidden
                className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[routine.status] || "bg-zinc-400")}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium leading-tight">
                  {routine.name || routine.promptPreview || routine.id}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {scheduleLabel(routine.cron)}
                  {" · "}
                  {t(`status.${routine.status}` as any)}
                  {routine.enabled && routine.nextRunAt ? (
                    <>
                      {" · "}
                      {t("next")}: {formatNextRun(routine.nextRunAt)}
                    </>
                  ) : null}
                </p>
              </div>
              {busyId === routine.id ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <>
                  {routine.enabled ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 rounded-md"
                      aria-label={t("pause")}
                      onClick={() => void mutate(routine.id, "pause")}
                    >
                      <PauseCircle className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 rounded-md"
                      aria-label={t("resume")}
                      onClick={() => void mutate(routine.id, "resume")}
                    >
                      <PlayCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 rounded-md text-rose-600 hover:text-rose-700 dark:text-rose-300"
                    aria-label={t("delete")}
                    onClick={() => void mutate(routine.id, "delete")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {loadError && routines != null ? (
        <p className="px-3 pb-1 text-[10px] text-amber-600 dark:text-amber-300">{t("stale")}</p>
      ) : null}
    </section>
  )
}

function CreateRoutineForm({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations("code.routines")
  const [name, setName] = React.useState("")
  const [cronExpr, setCronExpr] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await authenticatedFetch(`${API_BASE}/routines`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({
          name: name.trim() || undefined,
          cron: cronExpr.trim(),
          prompt: prompt.trim(),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message || body?.error || "create_failed")
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <DialogHeader>
        <DialogTitle>{t("create.title")}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="routine-name">{t("create.name")}</Label>
        <Input
          id="routine-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("create.namePlaceholder")}
          maxLength={120}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="routine-cron">{t("create.cron")}</Label>
        <Input
          id="routine-cron"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          placeholder="0 */3 * * *"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="routine-prompt">{t("create.prompt")}</Label>
        <Input
          id="routine-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("create.promptPlaceholder")}
          required
          minLength={3}
          maxLength={8000}
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-rose-600 dark:text-rose-300">
          {t("create.failed", { error })}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" size="sm" disabled={submitting} className="gap-1.5">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("create.submit")}
        </Button>
      </DialogFooter>
    </form>
  )
}
