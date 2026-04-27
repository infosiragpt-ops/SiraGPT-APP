"use client"

import * as React from "react"
import {
  Activity,
  AlertTriangle,
  Ban,
  Braces,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { agentTaskService, type AgentArtifact, type AgentTaskState } from "@/lib/agent-task-service"
import {
  formatQualityScore,
  professionalStepLabel,
  sanitizeAgentText,
  summarizeAgentActivity,
  toolToProfessionalLabel,
  type AgentActivityStatus,
} from "@/lib/agent-task-presentation"

interface Props {
  state: AgentTaskState
  className?: string
}

interface TimelineStepProjection {
  id: string
  label: string
  detail?: string
  status: "running" | "done" | "error"
  count: number
}

const STATUS_STYLES: Record<AgentActivityStatus, string> = {
  queued: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200",
  running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-200",
  verifying: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-200",
  repairing: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-200",
  cancelled: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200",
  error: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200",
  idle: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200",
}

function plural(value: number, singular: string, pluralLabel: string) {
  return `${value} ${value === 1 ? singular : pluralLabel}`
}

function etaLabel(ms?: number | null) {
  if (!ms || ms <= 0) return null
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s estimados`
  return `${Math.ceil(seconds / 60)}m estimados`
}

function projectTimelineSteps(steps: AgentTaskState["steps"]): TimelineStepProjection[] {
  const source = steps?.length ? steps : [{ id: "initial", label: "Analizando solicitud", status: "running" as const, toolCalls: [] }]
  const projected: TimelineStepProjection[] = []

  for (const step of source) {
    const tools = Array.from(new Set((step.toolCalls || []).map((call) => toolToProfessionalLabel(call.tool)))).slice(0, 2)
    const item: TimelineStepProjection = {
      id: step.id,
      label: professionalStepLabel(step),
      detail: tools.length ? tools.join(" · ") : undefined,
      status: step.status === "running" ? "running" : step.status === "error" ? "error" : "done",
      count: 1,
    }
    const previous = projected[projected.length - 1]
    if (previous && previous.label === item.label && previous.detail === item.detail && previous.status === item.status) {
      previous.count += 1
      previous.id = item.id
    } else {
      projected.push(item)
    }
  }

  return projected
}

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function StatusIcon({ status }: { status: AgentActivityStatus | "step-running" | "step-done" | "step-error" }) {
  if (status === "running" || status === "step-running") return <Loader2 className="h-4 w-4 animate-spin" />
  if (status === "completed" || status === "step-done") return <CheckCircle2 className="h-4 w-4" />
  if (status === "error" || status === "step-error") return <XCircle className="h-4 w-4" />
  if (status === "repairing") return <Wrench className="h-4 w-4" />
  if (status === "verifying") return <ShieldCheck className="h-4 w-4" />
  if (status === "cancelled") return <Ban className="h-4 w-4" />
  if (status === "queued") return <Clock3 className="h-4 w-4" />
  return <Sparkles className="h-4 w-4" />
}

function StatusPill({ status, label }: { status: AgentActivityStatus; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLES[status])}>
      <StatusIcon status={status} />
      {label}
    </span>
  )
}

function DownloadButton({ artifact, href }: { artifact: AgentArtifact; href: string }) {
  const [downloading, setDownloading] = React.useState(false)

  const download = React.useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const response = await fetch(href, {
        credentials: "include",
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = artifact.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000)
    } catch {
      window.open(href, "_blank", "noopener,noreferrer")
    } finally {
      setDownloading(false)
    }
  }, [artifact.filename, downloading, href])

  return (
    <button
      type="button"
      onClick={download}
      disabled={downloading}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      title="Descargar documento"
    >
      {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
    </button>
  )
}

function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const apiRoot = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
  const href = artifact.downloadUrl.startsWith("http")
    ? artifact.downloadUrl
    : `${apiRoot.replace(/\/api$/, "")}${artifact.downloadUrl}`
  const sizeKb = Math.max(1, Math.round((artifact.sizeBytes || 0) / 1024))

  return (
    <div className="rounded-md border border-border/60 bg-background/70 p-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
          <FileCheck2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{artifact.filename}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{artifact.mime || "archivo generado"}</span>
            <span>{sizeKb} KB</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">
              <ShieldCheck className="h-3 w-3" />
              Validado
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Abrir documento"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <DownloadButton artifact={artifact} href={href} />
        </div>
      </div>
      {artifact.previewHtml && (
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border/50 bg-muted/10">
          <div dangerouslySetInnerHTML={{ __html: artifact.previewHtml }} />
        </div>
      )}
    </div>
  )
}

function TimelineRow({
  icon,
  label,
  detail,
  status,
  badges = [],
}: {
  icon: React.ReactNode
  label: string
  detail?: string
  status?: "running" | "done" | "error" | "muted"
  badges?: string[]
}) {
  return (
    <div className="relative flex gap-3">
      <div className="flex w-6 shrink-0 justify-center text-muted-foreground">
        <div className={cn(
          "mt-0.5 flex h-6 w-6 items-center justify-center bg-background",
          status === "done" && "text-emerald-600",
          status === "running" && "text-blue-600",
          status === "error" && "text-red-600",
          (!status || status === "muted") && "text-muted-foreground",
        )}>
          {icon}
        </div>
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {badges.map((badge) => (
            <span key={badge} className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          ))}
        </div>
        {detail && <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>}
      </div>
    </div>
  )
}

function ValidationSummary({ state }: { state: AgentTaskState }) {
  if (!state.qualityGates?.length) return null
  const passed = state.qualityGates.filter((gate) => gate.passed).length
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
          Validaciones
        </div>
        <span className="text-xs font-medium text-muted-foreground">{passed}/{state.qualityGates.length} aprobadas</span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {state.qualityGates.slice(-6).map((gate) => (
          <div key={gate.id} className="flex items-center gap-2 rounded-md bg-background px-2 py-1 text-xs">
            {gate.passed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
            <span className="min-w-0 flex-1 truncate">{sanitizeAgentText(gate.label, "Validación")}</span>
            {typeof gate.score === "number" && <span className="text-muted-foreground">{formatQualityScore(gate.score)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function AgenticStepsRenderer({ state, className }: Props) {
  const [retrying, setRetrying] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const summary = React.useMemo(() => summarizeAgentActivity(state), [state])
  const timelineSteps = React.useMemo(() => projectTimelineSteps(state.steps), [state.steps])
  const taskId = state.meta?.taskId
  const canCancel = Boolean(taskId && !state.done && !state.error)
  const canRetry = Boolean(taskId && (state.error || summary.status === "cancelled"))
  const hasDeliverable = (state.artifacts?.length || 0) > 0
  const hasValidation = (state.qualityGates?.length || 0) > 0
  const isCompactCompletedChat = Boolean(
    state.done &&
    !state.error &&
    !hasDeliverable &&
    !hasValidation &&
    state.documentPolicy?.mode !== "doc_required"
  )

  const cancelTask = React.useCallback(async () => {
    if (!taskId || cancelling) return
    setCancelling(true)
    try {
      await agentTaskService.cancelTask(taskId)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("agent-task-cancel", { detail: { taskId } }))
      }
    } finally {
      setCancelling(false)
    }
  }, [cancelling, taskId])

  const retryTask = React.useCallback(async () => {
    if (!taskId || retrying) return
    setRetrying(true)
    try {
      await agentTaskService.retryTask(taskId)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("agent-task-retry", { detail: { taskId } }))
      }
    } finally {
      setRetrying(false)
    }
  }, [retrying, taskId])

  if (isCompactCompletedChat) {
    return (
      <div className={cn("my-2 flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <span className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
          <Braces className="h-4 w-4" />
        </span>
        <span className="font-medium text-foreground">{summary.label}</span>
        <span>{plural(summary.stepCount, "paso", "pasos")}</span>
      </div>
    )
  }

  return (
    <div className={cn("my-2 w-full max-w-2xl bg-transparent p-0 shadow-none", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
              <Braces className="h-3.5 w-3.5" />
              Proceso
            </span>
            <StatusPill status={summary.status} label={summary.label} />
            {state.documentPolicy && state.documentPolicy.mode !== "chat_only" && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                Documento
                <span className="uppercase text-foreground">{state.documentPolicy.format}</span>
              </span>
            )}
          </div>
          <div className="mt-2 text-xs font-medium text-muted-foreground">
            <span className="text-foreground">{plural(summary.stepCount, "paso", "pasos")}</span>
            <span className="mx-1.5">·</span>
            <span>{plural(summary.toolCount, "herramienta", "herramientas")}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canCancel && (
            <button
              type="button"
              onClick={cancelTask}
              disabled={cancelling}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              Cancelar
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={retryTask}
              disabled={retrying}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Reintentar
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 border-l border-border/60 pl-3">
        {state.queue && !state.done && (
          <TimelineRow
            icon={state.queue.status === "running" ? <Terminal className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
            label={state.queue.status === "queued" ? "En cola" : state.queue.status === "running" ? "Ejecutando tarea" : sanitizeAgentText(state.queue.status, "Estado de cola")}
            detail={[state.queue.queue ? `Cola ${state.queue.queue}` : null, etaLabel(state.queue.estimatedWaitMs)].filter(Boolean).join(" · ") || undefined}
            status={state.queue.status === "running" ? "running" : state.queue.status === "error" ? "error" : "muted"}
          />
        )}

        {timelineSteps.map((step) => {
          return (
            <TimelineRow
              key={step.id}
              icon={
                step.status === "running"
                  ? <Terminal className="h-3.5 w-3.5" />
                  : step.status === "error"
                    ? <XCircle className="h-3.5 w-3.5" />
                    : <CheckCircle2 className="h-3.5 w-3.5" />
              }
              label={step.label}
              detail={step.detail}
              status={step.status}
              badges={step.count > 1 ? [`${step.count} pasos`] : []}
            />
          )
        })}

        {state.repairs?.slice(-3).map((repair) => (
          <TimelineRow
            key={`${repair.attempt}-${repair.ts || repair.message}`}
            icon={<Wrench className="h-3.5 w-3.5" />}
            label={`Reparación automática ${repair.attempt}`}
            detail={sanitizeAgentText(repair.message, "Regenerando la entrega para corregir validaciones.")}
            status={repair.status === "completed" ? "done" : "running"}
          />
        ))}

        {state.done && !state.error && (
          <TimelineRow
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Listo"
            detail="La respuesta final y los documentos quedaron disponibles."
            status="done"
          />
        )}
      </div>

      {(state.checkpoints?.length || 0) > 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Checkpoint:</span>
          <span className="min-w-0 truncate">{sanitizeAgentText(state.checkpoints[state.checkpoints.length - 1]?.label, "Progreso guardado")}</span>
        </div>
      )}

      <div className="mt-3">
        <ValidationSummary state={state} />
      </div>

      {state.artifacts?.length > 0 && (
        <div className="mt-3 space-y-2">
          {state.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
        </div>
      )}

      {state.error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
          {state.error === "aborted" ? "Tarea detenida por el usuario." : state.error}
        </div>
      )}
    </div>
  )
}

export default AgenticStepsRenderer
