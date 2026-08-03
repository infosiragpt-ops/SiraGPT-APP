"use client"

import * as React from "react"
import {
  ChevronRight,
  Pause,
  Play,
  Square,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

export type EnterpriseRunState =
  | "idle"
  | "queued"
  | "running"
  | "paused"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
export type EnterpriseReadinessState = "ready" | "attention" | "blocked"
export type EnterpriseDepartmentStatus =
  | "planned"
  | "active"
  | "queued"
  | "waiting_approval"
  | "paused"
  | "cancelling"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled"
export type EnterpriseEventStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled"
export type EnterpriseEventKind =
  | "planning"
  | "delegation"
  | "research"
  | "coding"
  | "verification"
  | "delivery"
  | "warning"
  | "error"

export interface EnterpriseReadinessCheck {
  id: string
  label: string
  status: EnterpriseReadinessState
  detail?: string
}

export interface EnterpriseReadiness {
  status: EnterpriseReadinessState
  score: number
  runState: EnterpriseRunState
  checks: EnterpriseReadinessCheck[]
  lastCheckedAt?: string | null
}

export interface EnterpriseSwarmSummary {
  logicalAgents: number
  planned: number
  active: number
  queued: number
  blocked: number
  completed: number
  failed: number
  cancelled: number
  maxParallel: number
}

export interface EnterpriseDepartment {
  id: string
  name: string
  objective: string
  status: EnterpriseDepartmentStatus
  logicalAgents: number
  plannedTasks: number
  activeAgents: number
  queuedTasks: number
  blockedTasks: number
  failedTasks: number
  cancelledTasks: number
  completedTasks: number
  progress: number
  currentWork?: string
  owner?: string
  lastUpdatedAt?: string | null
}

export interface EnterpriseLiveEvent {
  id: string
  timestamp: string
  title: string
  kind: EnterpriseEventKind
  status: EnterpriseEventStatus
  detail?: string
  departmentId?: string
  departmentName?: string
}

export interface EnterpriseExecutiveSummary {
  title: string
  summary: string
  updatedAt?: string | null
  highlights?: string[]
  risks?: string[]
  nextActions?: string[]
}

export type EnterpriseCommandCenterTarget =
  | { type: "readiness" }
  | { type: "department"; id: string }
  | { type: "event"; id: string }
  | { type: "executive-summary" }

export interface EnterpriseCommandCenterProps {
  readiness: EnterpriseReadiness
  mission: string
  vision: string
  swarmSummary: EnterpriseSwarmSummary
  departments: EnterpriseDepartment[]
  liveEvents: EnterpriseLiveEvent[]
  executiveSummary: EnterpriseExecutiveSummary
  onStart: () => void
  onPause: () => void
  onCancel: () => void
  onOpen: (target: EnterpriseCommandCenterTarget) => void
  className?: string
}

type CommandTab = "overview" | "departments" | "activity"

const numberFormatter = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 })
const timeFormatter = new Intl.DateTimeFormat("es-PE", {
  hour: "2-digit",
  minute: "2-digit",
})

const commandTabs = [
  { id: "overview", label: "Operación" },
  { id: "departments", label: "Departamentos" },
  { id: "activity", label: "Actividad" },
] as const

const runStateLabels: Record<EnterpriseRunState, string> = {
  idle: "En espera",
  queued: "En cola",
  running: "En ejecución",
  paused: "En pausa",
  waiting_approval: "Esperando aprobación",
  cancelling: "Cancelando",
  completed: "Completado",
  completed_with_errors: "Completado con errores",
  failed: "Con errores",
  cancelled: "Cancelado",
}

const departmentStatusLabels: Record<EnterpriseDepartmentStatus, string> = {
  planned: "Planificado",
  active: "Activo",
  queued: "En cola",
  waiting_approval: "Esperando aprobación",
  paused: "En pausa",
  cancelling: "Cancelando",
  blocked: "Bloqueado",
  failed: "Fallido",
  completed: "Completado",
  cancelled: "Cancelado",
}

const eventStatusLabels: Record<EnterpriseEventStatus, string> = {
  queued: "En cola",
  running: "En curso",
  completed: "Completado",
  blocked: "Bloqueado",
  failed: "Fallido",
  cancelled: "Cancelado",
}

const eventKindLabels: Record<EnterpriseEventKind, string> = {
  planning: "Planificación",
  delegation: "Delegación",
  research: "Investigación",
  coding: "Código",
  verification: "Verificación",
  delivery: "Entrega",
  warning: "Advertencia",
  error: "Error",
}

const readinessStyles: Record<EnterpriseReadinessState, string> = {
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-destructive/30 bg-destructive/10 text-destructive",
}

const departmentStatusStyles: Record<EnterpriseDepartmentStatus, string> = {
  planned: "border-border bg-background text-muted-foreground",
  active: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  queued: "border-border bg-muted/60 text-muted-foreground",
  waiting_approval: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paused: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  cancelling: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-destructive/30 bg-destructive/10 text-destructive",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  cancelled: "border-border bg-muted/60 text-muted-foreground",
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function formatCount(value: number): string {
  return numberFormatter.format(Math.max(0, value))
}

function formatEventTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date)
}

function ReadinessIcon({
  status,
  className,
}: {
  status: EnterpriseReadinessState
  className?: string
}) {
  return (
    <span
      className={cn(
        "rounded-full border-2",
        status === "ready" && "border-emerald-500 bg-emerald-500/20",
        status === "attention" && "border-amber-500 bg-amber-500/20",
        status === "blocked" && "border-destructive bg-destructive/20",
        className,
      )}
      aria-hidden="true"
    />
  )
}

function EventStatusIcon({
  status,
  className,
}: {
  status: EnterpriseEventStatus
  className?: string
}) {
  return (
    <span
      className={cn(
        "rounded-full border-2",
        status === "completed" && "border-emerald-500 bg-emerald-500/20",
        status === "blocked" && "border-amber-500 bg-amber-500/20",
        status === "failed" && "border-destructive bg-destructive/20",
        status === "cancelled" && "border-muted-foreground bg-muted",
        status === "queued" && "border-muted-foreground bg-background",
        status === "running" && "animate-pulse border-sky-500 bg-sky-500/20 motion-reduce:animate-none",
        className,
      )}
      aria-hidden="true"
    />
  )
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: number
  tone?: "default" | "active" | "success" | "warning" | "danger"
}) {
  return (
    <div className="min-w-0 border-r border-border/70 px-3 py-3 last:border-r-0 sm:px-4">
      <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums text-foreground",
          tone === "active" && "text-sky-700 dark:text-sky-300",
          tone === "success" && "text-emerald-700 dark:text-emerald-300",
          tone === "warning" && value > 0 && "text-amber-700 dark:text-amber-300",
          tone === "danger" && value > 0 && "text-destructive",
        )}
      >
        {formatCount(value)}
      </p>
    </div>
  )
}

function ReadinessSection({
  readiness,
  onOpen,
}: {
  readiness: EnterpriseReadiness
  onOpen: EnterpriseCommandCenterProps["onOpen"]
}) {
  const score = clampPercentage(readiness.score)

  return (
    <section aria-labelledby="enterprise-readiness-title" className="border-t border-border">
      <div className="flex items-start justify-between gap-4 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 id="enterprise-readiness-title" className="text-sm font-semibold text-foreground">
            Preparación operativa
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Condiciones necesarias antes de ampliar la ejecución.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpen({ type: "readiness" })}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 text-sm font-semibold tabular-nums text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Abrir preparación operativa, ${score} por ciento`}
        >
          {score}%
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
      <div className="px-4 pb-4 sm:px-5">
        <Progress
          value={score}
          max={100}
          role="progressbar"
          aria-label="Preparación operativa"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={score}
          className="h-1.5"
        />
        <ul className="mt-3 divide-y divide-border/70 border-y border-border/70">
          {readiness.checks.length > 0 ? (
            readiness.checks.map((check) => (
              <li key={check.id} className="flex min-w-0 items-start gap-3 py-2.5">
                <ReadinessIcon status={check.status} className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{check.label}</p>
                  {check.detail ? (
                    <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{check.detail}</p>
                  ) : null}
                </div>
                <span className="sr-only">
                  {check.status === "ready"
                    ? "Listo"
                    : check.status === "attention"
                      ? "Requiere atención"
                      : "Bloqueado"}
                </span>
              </li>
            ))
          ) : (
            <li className="py-3 text-sm text-muted-foreground">No hay verificaciones disponibles.</li>
          )}
        </ul>
      </div>
    </section>
  )
}

function ExecutiveSummaryPanel({
  summary,
  onOpen,
}: {
  summary: EnterpriseExecutiveSummary
  onOpen: EnterpriseCommandCenterProps["onOpen"]
}) {
  const groups = [
    { label: "Resultados", values: summary.highlights ?? [], tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Riesgos", values: summary.risks ?? [], tone: "text-amber-600 dark:text-amber-400" },
    { label: "Siguientes acciones", values: summary.nextActions ?? [], tone: "text-sky-600 dark:text-sky-400" },
  ]

  return (
    <section aria-labelledby="enterprise-summary-title" className="border-t border-border px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">Resumen ejecutivo</p>
          <h3 id="enterprise-summary-title" className="mt-1 text-base font-semibold text-foreground">
            {summary.title}
          </h3>
          {summary.updatedAt ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Actualizado {formatEventTime(summary.updatedAt)}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onOpen({ type: "executive-summary" })}
          className="h-11 w-11 shrink-0"
          aria-label="Abrir resumen ejecutivo"
          title="Abrir resumen ejecutivo"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-muted-foreground">{summary.summary}</p>
      {groups.some((group) => group.values.length > 0) ? (
        <div className="mt-4 grid gap-4 border-t border-border/70 pt-4 md:grid-cols-3">
          {groups.map((group) => (
            <div key={group.label} className="min-w-0">
              <p className={cn("text-xs font-semibold", group.tone)}>{group.label}</p>
              {group.values.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {group.values.slice(0, 3).map((value) => (
                    <li key={value} className="flex gap-2 text-xs leading-5 text-muted-foreground">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
                      <span className="break-words">{value}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Sin novedades.</p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DepartmentList({
  departments,
  onOpen,
}: {
  departments: EnterpriseDepartment[]
  onOpen: EnterpriseCommandCenterProps["onOpen"]
}) {
  return (
    <section aria-labelledby="enterprise-departments-title" className="min-w-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <h3 id="enterprise-departments-title" className="text-sm font-semibold text-foreground">
            Departamentos
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatCount(departments.length)} unidades coordinadas
          </p>
        </div>
      </div>
      {departments.length > 0 ? (
        <ul className="divide-y divide-border">
          {departments.map((department) => {
            const progress = clampPercentage(department.progress)
            return (
              <li key={department.id} className="px-4 py-3 sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="break-words text-sm font-semibold text-foreground">{department.name}</h4>
                      <Badge
                        variant="outline"
                        className={cn("gap-1 rounded-md px-1.5 py-0 text-[10px]", departmentStatusStyles[department.status])}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                        {departmentStatusLabels[department.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{department.objective}</p>
                    {department.currentWork ? (
                      <p className="mt-1.5 break-words text-xs text-foreground">
                        <span className="font-medium">Ahora:</span> {department.currentWork}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                      {department.plannedTasks > 0 ? (
                        <span>{formatCount(department.plannedTasks)} planificadas</span>
                      ) : null}
                      <span>{formatCount(department.logicalAgents)} agentes reales</span>
                      {department.activeAgents > 0 ? (
                        <span>{formatCount(department.activeAgents)} activos</span>
                      ) : null}
                      {department.queuedTasks > 0 ? (
                        <span>{formatCount(department.queuedTasks)} en cola</span>
                      ) : null}
                      {department.blockedTasks > 0 ? (
                        <span className="text-amber-700 dark:text-amber-300">
                          {formatCount(department.blockedTasks)} bloqueadas
                        </span>
                      ) : null}
                      <span>{formatCount(department.completedTasks)} completadas</span>
                      {department.cancelledTasks > 0 ? (
                        <span>{formatCount(department.cancelledTasks)} canceladas</span>
                      ) : null}
                      {department.failedTasks > 0 ? (
                        <span className="text-destructive">{formatCount(department.failedTasks)} fallidas</span>
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <Progress
                        value={progress}
                        max={100}
                        role="progressbar"
                        aria-label={`Progreso de ${department.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                        className="h-1.5 flex-1"
                      />
                      <span className="w-9 text-right text-[11px] font-medium tabular-nums text-muted-foreground">
                        {progress}%
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onOpen({ type: "department", id: department.id })}
                    className="h-11 w-11 shrink-0"
                    aria-label={`Abrir departamento ${department.name}`}
                    title={`Abrir ${department.name}`}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center">
          <p className="mt-2 text-sm font-medium text-foreground">Sin departamentos configurados</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            El CEO Office mostrará aquí cada unidad cuando esté disponible.
          </p>
        </div>
      )}
    </section>
  )
}

function LiveTimeline({
  events,
  onOpen,
  compact = false,
}: {
  events: EnterpriseLiveEvent[]
  onOpen: EnterpriseCommandCenterProps["onOpen"]
  compact?: boolean
}) {
  const visibleEvents = compact ? events.slice(0, 6) : events
  const hasLiveActivity = visibleEvents.some((event) => event.status === "running")

  return (
    <section aria-labelledby={compact ? "enterprise-live-title" : "enterprise-activity-title"} className="min-w-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <div className="flex items-center gap-2">
            <h3
              id={compact ? "enterprise-live-title" : "enterprise-activity-title"}
              className="text-sm font-semibold text-foreground"
            >
              {hasLiveActivity ? "Actividad en vivo" : "Actividad registrada"}
            </h3>
            <span className="relative flex h-2 w-2" aria-hidden="true">
              {hasLiveActivity ? (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-50 motion-reduce:animate-none" />
              ) : null}
              <span className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                hasLiveActivity ? "bg-emerald-500" : "bg-muted-foreground/60",
              )} />
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Decisiones, ejecución y verificaciones</p>
        </div>
      </div>
      {visibleEvents.length > 0 ? (
        <ol
          className="divide-y divide-border"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Línea temporal de actividad de agentes"
        >
          {visibleEvents.map((event) => (
            <li key={event.id} className="group px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-start gap-3">
                <EventStatusIcon
                  status={event.status}
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    event.status === "completed" && "text-emerald-600 dark:text-emerald-400",
                    event.status === "blocked" && "text-amber-600 dark:text-amber-400",
                    event.status === "failed" && "text-destructive",
                    event.status === "cancelled" && "text-muted-foreground",
                    event.status === "queued" && "text-muted-foreground",
                    event.status === "running" && "text-sky-600 dark:text-sky-400",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="break-words text-sm font-medium text-foreground">{event.title}</p>
                    <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {eventKindLabels[event.kind]}
                    </span>
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {eventStatusLabels[event.status]}
                    </span>
                  </div>
                  {event.detail ? (
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{event.detail}</p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                    {event.departmentName ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="break-words">{event.departmentName}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onOpen({ type: "event", id: event.id })}
                  className="h-11 w-11 shrink-0 opacity-70 group-hover:opacity-100"
                  aria-label={`Abrir evento ${event.title}`}
                  title="Abrir evento"
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center" aria-live="polite">
          <p className="mt-2 text-sm font-medium text-foreground">Esperando actividad</p>
          <p className="mt-1 text-xs text-muted-foreground">Los pasos del enjambre aparecerán aquí en tiempo real.</p>
        </div>
      )}
    </section>
  )
}

export function EnterpriseCommandCenter({
  readiness,
  mission,
  vision,
  swarmSummary,
  departments,
  liveEvents,
  executiveSummary,
  onStart,
  onPause,
  onCancel,
  onOpen,
  className,
}: EnterpriseCommandCenterProps) {
  const [activeTab, setActiveTab] = React.useState<CommandTab>("overview")
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const resumable = readiness.runState === "paused"
  const canStart = readiness.status !== "blocked" && (
    readiness.runState === "idle"
    || readiness.runState === "paused"
    || readiness.runState === "completed"
    || readiness.runState === "completed_with_errors"
    || readiness.runState === "failed"
    || readiness.runState === "cancelled"
  )
  const canPause = readiness.runState === "running"
  const canCancel = readiness.runState === "queued"
    || readiness.runState === "running"
    || readiness.runState === "paused"
    || readiness.runState === "waiting_approval"
  const capacity = swarmSummary.maxParallel > 0
    ? clampPercentage((swarmSummary.active / swarmSummary.maxParallel) * 100)
    : 0

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null

    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % commandTabs.length
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + commandTabs.length) % commandTabs.length
    if (event.key === "Home") nextIndex = 0
    if (event.key === "End") nextIndex = commandTabs.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    setActiveTab(commandTabs[nextIndex].id)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-border bg-background text-foreground",
        className,
      )}
      aria-labelledby="enterprise-command-center-title"
      data-testid="enterprise-command-center"
    >
      <header className="border-b border-border">
        <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                CEO Office
              </span>
              <Badge
                variant="outline"
                className={cn("gap-1.5 rounded-md px-2 py-0.5 text-[11px]", readinessStyles[readiness.status])}
                role="status"
              >
                <ReadinessIcon status={readiness.status} className="h-3.5 w-3.5" />
                {readiness.status === "ready"
                  ? "Listo"
                  : readiness.status === "attention"
                    ? "Atención"
                    : "Bloqueado"}
              </Badge>
            </div>
            <h2 id="enterprise-command-center-title" className="mt-1 text-lg font-semibold text-foreground">
              Centro de mando de agentes
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    readiness.runState === "queued" && "bg-sky-500",
                    readiness.runState === "running" && "bg-emerald-500",
                    (readiness.runState === "paused" || readiness.runState === "waiting_approval") && "bg-amber-500",
                    readiness.runState === "cancelling" && "animate-pulse bg-amber-500 motion-reduce:animate-none",
                    readiness.runState === "completed" && "bg-emerald-500",
                    readiness.runState === "completed_with_errors" && "bg-amber-500",
                    readiness.runState === "failed" && "bg-destructive",
                    (readiness.runState === "idle" || readiness.runState === "cancelled") && "bg-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                {runStateLabels[readiness.runState]}
              </span>
              {readiness.lastCheckedAt ? (
                <span>Verificado {formatEventTime(readiness.lastCheckedAt)}</span>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center" aria-label="Controles de ejecución">
            <Button
              type="button"
              onClick={onStart}
              disabled={!canStart}
              className="h-11 min-w-0 px-3 sm:min-w-28"
              aria-label={resumable ? "Reanudar ejecución de agentes" : "Iniciar ejecución de agentes"}
            >
              <Play aria-hidden="true" />
              {resumable ? "Reanudar" : "Iniciar"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onPause}
              disabled={!canPause}
              className="h-11 min-w-0 px-3 sm:min-w-28"
              aria-label="Pausar ejecución de agentes"
            >
              <Pause aria-hidden="true" />
              Pausar
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={!canCancel}
              className="h-11 min-w-0 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive sm:min-w-28"
              aria-label="Cancelar ejecución de agentes"
            >
              <Square aria-hidden="true" />
              Cancelar
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 border-t border-border sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9" aria-label="Resumen del enjambre">
          <Metric label="Agentes reales" value={swarmSummary.logicalAgents} />
          <Metric label="Planificadas" value={swarmSummary.planned} />
          <Metric label="Activos" value={swarmSummary.active} tone="active" />
          <Metric label="En cola" value={swarmSummary.queued} />
          <Metric label="Bloqueadas" value={swarmSummary.blocked} tone="warning" />
          <Metric label="Completados" value={swarmSummary.completed} tone="success" />
          <Metric label="Cancelados" value={swarmSummary.cancelled} />
          <Metric label="Fallidos" value={swarmSummary.failed} tone="danger" />
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[11px] font-medium text-muted-foreground">Capacidad paralela</p>
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{capacity}%</span>
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {formatCount(swarmSummary.active)}
              <span className="text-xs font-normal text-muted-foreground"> / {formatCount(swarmSummary.maxParallel)}</span>
            </p>
            <Progress
              value={capacity}
              max={100}
              role="progressbar"
              aria-label="Capacidad paralela utilizada"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={capacity}
              className="mt-1 h-1"
            />
          </div>
        </div>

        <nav
          className="grid w-full grid-cols-3 border-t border-border bg-muted/20 p-1 sm:w-fit sm:min-w-[430px]"
          role="tablist"
          aria-label="Vistas del centro de mando"
        >
          {commandTabs.map((tab, tabIndex) => {
            const selected = activeTab === tab.id
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tabIndex] = node
                }}
                type="button"
                role="tab"
                id={`enterprise-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`enterprise-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
                className={cn(
                  "inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <span className="truncate">{tab.label}</span>
              </button>
            )
          })}
        </nav>
      </header>

      {activeTab === "overview" ? (
        <div
          id="enterprise-panel-overview"
          role="tabpanel"
          aria-labelledby="enterprise-tab-overview"
          className="grid min-w-0 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]"
        >
          <div className="min-w-0 xl:border-r xl:border-border">
            <section aria-labelledby="enterprise-direction-title" className="grid min-w-0 md:grid-cols-2">
              <div className="min-w-0 px-4 py-4 sm:px-5 md:border-r md:border-border">
                <div className="flex items-center gap-2">
                  <span className="h-4 w-1 rounded-full bg-sky-500" aria-hidden="true" />
                  <h3 id="enterprise-direction-title" className="text-sm font-semibold text-foreground">
                    Misión
                  </h3>
                </div>
                <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{mission}</p>
              </div>
              <div className="min-w-0 border-t border-border px-4 py-4 sm:px-5 md:border-t-0">
                <div className="flex items-center gap-2">
                  <span className="h-4 w-1 rounded-full bg-violet-500" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-foreground">Visión</h3>
                </div>
                <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{vision}</p>
              </div>
            </section>
            <ReadinessSection readiness={readiness} onOpen={onOpen} />
            <ExecutiveSummaryPanel summary={executiveSummary} onOpen={onOpen} />
          </div>
          <LiveTimeline events={liveEvents} onOpen={onOpen} compact />
        </div>
      ) : null}

      {activeTab === "departments" ? (
        <div
          id="enterprise-panel-departments"
          role="tabpanel"
          aria-labelledby="enterprise-tab-departments"
          className="min-w-0"
        >
          <DepartmentList departments={departments} onOpen={onOpen} />
        </div>
      ) : null}

      {activeTab === "activity" ? (
        <div
          id="enterprise-panel-activity"
          role="tabpanel"
          aria-labelledby="enterprise-tab-activity"
          className="min-w-0"
        >
          <LiveTimeline events={liveEvents} onOpen={onOpen} />
        </div>
      ) : null}

      <footer className="flex flex-col gap-2 border-t border-border bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
          {swarmSummary.logicalAgents > 0
            ? `${formatCount(swarmSummary.logicalAgents)} agentes persistidos y coordinados por CEO Office`
            : `${formatCount(swarmSummary.planned)} tareas planificadas, todavía sin agentes en ejecución`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {formatCount(swarmSummary.completed)} tareas verificadas
        </span>
      </footer>
    </section>
  )
}
