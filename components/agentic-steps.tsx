"use client"

import * as React from "react"
import Image from "next/image"
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Globe,
  Eye,
  FileCheck2,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { AgentStatusIcon, type AgentStatusIconKind } from "@/components/icons/agent-status-icons"
import { agentTaskService, type AgentArtifact, type AgentTaskState } from "@/lib/agent-task-service"
import {
  formatQualityScore,
  professionalStepLabel,
  sanitizeAgentText,
  summarizeAgentActivity,
  toolToProfessionalLabel,
  type AgentActivityStatus,
} from "@/lib/agent-task-presentation"
import type { DocumentPreviewTarget } from "@/components/document-preview"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { DotmCircular15 } from "@/components/ui/dotm-circular-15"
interface Props {
  state: AgentTaskState
  className?: string
  onDocumentPreview?: (target: DocumentPreviewTarget) => void
  /**
   * Agent harness: when the typed AgentTrace timeline is rendering this
   * message's steps, the sentinel contributes only its artifacts (same
   * clean surface the completed state already uses) so the user never
   * sees two timelines for one turn.
   */
  hideSteps?: boolean
}

interface ProjectedSearchCall {
  query?: string
  count?: number
  sources?: Array<{ title?: string; url?: string }>
}

interface TimelineStepProjection {
  id: string
  label: string
  detail?: string
  status: "running" | "done" | "error"
  phase: AgentStatusIconKind
  count: number
  /** Claude-style web research trace: queries + their result lists. */
  searchCalls: ProjectedSearchCall[]
  /** Domains the agent is fetching ("Obteniendo datos de …"). */
  fetchTargets: string[]
}

const SEARCH_TOOL_RE = /search/i
const FETCH_TOOL_RE = /(browse|navigate|read_url|url_read|fetch|scrape|open_page|visit)/i

function domainOf(url?: string): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function etaLabel(ms?: number | null) {
  if (!ms || ms <= 0) return null
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s estimados`
  return `${Math.ceil(seconds / 60)}m estimados`
}

function phaseFromTool(tool?: string | null): AgentStatusIconKind {
  const normalized = String(tool || "").toLowerCase()
  if (!normalized) return "thinking"
  if (/(verify|valid|quality|gate|audit|check|run_tests)/i.test(normalized)) return "verifying"
  if (/(repair|regen|fix|corrig|repar)/i.test(normalized)) return "repairing"
  if (/(python|bash|code|sandbox|script|lint|build|dev|terminal|exec)/i.test(normalized)) return "coding"
  if (/(search|rag|retrieve|source|web|investig|self_rag)/i.test(normalized)) return "thinking"
  return "working"
}

function phaseFromStep(step: AgentTaskState["steps"][number], label: string): AgentStatusIconKind {
  const firstTool = step.toolCalls?.[0]?.tool
  if (firstTool) return phaseFromTool(firstTool)
  const raw = `${step.icon || ""} ${step.label || ""} ${label}`.toLowerCase()
  if (/(plan|analiz|analy|think|thought|pens)/i.test(raw)) return "thinking"
  if (/(verify|valid|quality|gate|verific|validac|check)/i.test(raw)) return "verifying"
  if (/(repair|regen|corrig|repar)/i.test(raw)) return "repairing"
  if (/(code|codig|python|bash|sandbox|script|test|build|lint|terminal)/i.test(raw)) return "coding"
  if (/(final|resumen|ready|listo)/i.test(raw)) return "done"
  return "working"
}

function phaseFromStatus(status: AgentActivityStatus): AgentStatusIconKind {
  if (status === "queued" || status === "idle") return "queued"
  if (status === "verifying") return "verifying"
  if (status === "repairing") return "repairing"
  if (status === "completed") return "done"
  if (status === "error") return "error"
  if (status === "cancelled") return "error"
  return "working"
}

function projectTimelineSteps(steps: AgentTaskState["steps"]): TimelineStepProjection[] {
  const source = steps?.length ? steps : [{
    id: "initial",
    label: "Analizando solicitud",
    reasoning: "Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea.",
    status: "running" as const,
    toolCalls: [],
  }]
  const projected: TimelineStepProjection[] = []

  for (const step of source) {
    const tools = Array.from(new Set((step.toolCalls || []).map((call) => toolToProfessionalLabel(call.tool)))).slice(0, 2)
    const label = professionalStepLabel(step)
    // Prefer the model's own reasoning narration (Claude-style transparency)
    // as the secondary line; fall back to the tool names when absent.
    const reasoning = typeof step.reasoning === "string" ? step.reasoning.trim() : ""
    // Claude-style research trace: surface searches (query + results) and
    // page fetches as first-class rows under the step.
    const searchCalls: ProjectedSearchCall[] = []
    const fetchTargets: string[] = []
    for (const call of step.toolCalls || []) {
      if (SEARCH_TOOL_RE.test(call.tool)) {
        searchCalls.push({
          query: call.preview,
          count: call.output?.resultCount ?? call.output?.sources?.length,
          sources: call.output?.sources,
        })
      } else if (FETCH_TOOL_RE.test(call.tool) && call.preview) {
        const target = domainOf(call.preview) || String(call.preview).slice(0, 60)
        if (target && !fetchTargets.includes(target)) fetchTargets.push(target)
      }
    }
    const item: TimelineStepProjection = {
      id: step.id,
      label,
      detail: reasoning || (tools.length ? tools.join(" · ") : undefined),
      status: step.status === "running" ? "running" : step.status === "error" ? "error" : "done",
      phase: phaseFromStep(step, label),
      count: 1,
      searchCalls,
      fetchTargets,
    }
    const previous = projected[projected.length - 1]
    if (previous && previous.label === item.label && previous.detail === item.detail && previous.status === item.status) {
      previous.count += 1
      previous.id = item.id
      previous.searchCalls.push(...item.searchCalls)
      previous.fetchTargets.push(...item.fetchTargets.filter((t) => !previous.fetchTargets.includes(t)))
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

/**
 * Claude-style research trace under a step: each search shows the query
 * line ("query…  ·  N resultados") followed by a quiet result list
 * (favicon + title + domain), and page fetches read as
 * "Obteniendo datos de dominio.com".
 */
function StepResearchTrace({ searchCalls, fetchTargets }: { searchCalls: ProjectedSearchCall[]; fetchTargets: string[] }) {
  if (!searchCalls.length && !fetchTargets.length) return null
  return (
    <div className="mt-1 space-y-1.5">
      {searchCalls.map((call, index) => (
        <div key={`s-${index}`}>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground/85">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
            <span className="min-w-0 flex-1 truncate">
              {call.query ? `“${call.query}”` : "Buscando…"}
            </span>
            {typeof call.count === "number" && (
              <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground/55">
                {call.count} resultado{call.count === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {(call.sources?.length ?? 0) > 0 && (
            <div className="ml-5 mt-1 max-h-44 overflow-y-auto rounded-xl border border-border/50 bg-background/60">
              {call.sources!.map((sourceItem, sourceIndex) => {
                const sourceDomain = domainOf(sourceItem.url)
                return (
                  <a
                    key={`src-${sourceIndex}`}
                    href={sourceItem.url || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2.5 px-3 py-1.5 transition-colors hover:bg-muted/40"
                  >
                    {sourceDomain ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`https://www.google.com/s2/favicons?sz=64&domain=${sourceDomain}`}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-sm"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                      />
                    ) : (
                      <Globe className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
                      {sourceItem.title || sourceItem.url}
                    </span>
                    {sourceDomain && (
                      <span className="shrink-0 text-[11.5px] text-muted-foreground/55">{sourceDomain}</span>
                    )}
                  </a>
                )
              })}
            </div>
          )}
        </div>
      ))}
      {fetchTargets.slice(-3).map((target, index) => (
        <div key={`f-${index}`} className="flex items-center gap-2 text-[12.5px] text-muted-foreground/75">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
          <span className="min-w-0 truncate">Obteniendo datos de {target}</span>
        </div>
      ))}
    </div>
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
      className="inline-flex h-14 w-14 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:opacity-60"
      title="Descargar documento"
      aria-label="Descargar documento"
    >
      {downloading ? <ThinkingIndicator size="lg" /> : <Download className="h-9 w-9 stroke-[2.25]" />}
    </button>
  )
}

function artifactDisplayName(artifact: AgentArtifact): string {
  const format = artifactFormat(artifact)
  if (format === "docx" || format === "doc") return "Documento Word"
  if (format === "xlsx" || format === "xls" || format === "csv") return "Hoja de calculo"
  if (format === "pptx" || format === "ppt") return "Presentacion"
  if (format === "pdf") return "Documento PDF"
  return "Archivo generado"
}

function artifactFormat(artifact: AgentArtifact): string {
  const explicit = String(artifact.format || "").toLowerCase()
  if (explicit) return explicit
  const filenameExt = artifact.filename.includes(".") ? artifact.filename.split(".").pop() || "" : ""
  if (filenameExt) return filenameExt.toLowerCase()
  const mime = String(artifact.mime || "").toLowerCase()
  if (mime.includes("wordprocessingml") || mime.includes("msword")) return "docx"
  if (mime.includes("spreadsheetml") || mime.includes("excel")) return "xlsx"
  if (mime.includes("presentationml") || mime.includes("powerpoint")) return "pptx"
  if (mime.includes("pdf")) return "pdf"
  return "bin"
}

function ArtifactFormatIcon({ artifact }: { artifact: AgentArtifact }) {
  const format = artifactFormat(artifact)
  if (format === "docx" || format === "doc") {
    return <Image src="/icons/Word.png" alt="Word" width={64} height={64} className="object-contain" />
  }
  if (format === "xlsx" || format === "xls" || format === "csv") {
    return <Image src="/icons/Excel.png" alt="Excel" width={64} height={64} className="object-contain" />
  }
  if (format === "pptx" || format === "ppt") {
    return <Image src="/icons/Bigger P powerpoint.png" alt="PowerPoint" width={64} height={64} className="object-contain" />
  }
  if (format === "pdf") {
    return <Image src="/icons/pdf.png" alt="PDF" width={64} height={64} className="object-contain" />
  }
  return <FileCheck2 className="h-14 w-14 text-slate-700" />
}

function ArtifactCard({
  artifact,
  onDocumentPreview,
}: {
  artifact: AgentArtifact
  onDocumentPreview?: (target: DocumentPreviewTarget) => void
}) {
  const apiRoot = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
  const href = artifact.downloadUrl.startsWith("http")
    ? artifact.downloadUrl
    : `${apiRoot.replace(/\/api$/, "")}${artifact.downloadUrl}`
  const sizeKb = Math.max(1, Math.round((artifact.sizeBytes || 0) / 1024))
  const displayName = artifactDisplayName(artifact)
  const format = artifactFormat(artifact)
  const formatLabel = format === "bin" ? "archivo" : format.toUpperCase()

  const preview = React.useCallback(() => {
    if (!onDocumentPreview) {
      window.open(href, "_blank", "noopener,noreferrer")
      return
    }

    const previewUrl = artifact.previewHtml
      ? `data:text/html;charset=utf-8,${encodeURIComponent(artifact.previewHtml)}`
      : href

    onDocumentPreview({
      url: previewUrl,
      downloadUrl: href,
      filename: artifact.filename,
    })
  }, [artifact.filename, artifact.previewHtml, href, onDocumentPreview])

  return (
    <div className="my-2 w-full max-w-xl rounded-2xl border border-border/70 bg-background p-4 shadow-sm">
      <div className="flex min-w-0 items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-muted/30">
            <ArtifactFormatIcon artifact={artifact} />
          </div>
          <div className="hidden min-w-0 sm:block">
            <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{formatLabel}</span>
              <span>{sizeKb} KB</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">
                <ShieldCheck className="h-3 w-3" />
                Validado
              </span>
            </div>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          <button
            type="button"
            onClick={preview}
            className="inline-flex h-14 w-14 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
            title="Ver documento"
            aria-label="Ver documento"
          >
            <Eye className="h-9 w-9 stroke-[2.25]" />
          </button>
          <DownloadButton artifact={artifact} href={href} />
        </div>
      </div>
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
    <div className="relative flex gap-2.5">
      <div className="flex w-5 shrink-0 justify-center text-muted-foreground">
        <div className={cn(
          "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 ring-1 ring-border/50",
          status === "done" && "text-emerald-600",
          status === "running" && "text-sky-600 shadow-[0_0_0_3px_rgba(14,165,233,0.08)]",
          status === "error" && "text-red-600",
          (!status || status === "muted") && "text-muted-foreground",
        )}>
          {icon}
        </div>
      </div>
      <div className="min-w-0 flex-1 pb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[13px] font-medium leading-5 text-foreground">{label}</div>
          {badges.map((badge) => (
            <span key={badge} className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          ))}
        </div>
        {detail && <div className="mt-0.5 max-w-[52rem] text-[12px] leading-5 text-muted-foreground">{detail}</div>}
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

export function AgenticStepsRenderer({ state, className, onDocumentPreview, hideSteps = false }: Props) {
  const [retrying, setRetrying] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  // Claude-style live trace: expanded by default while the agent runs;
  // the user's toggle wins for the rest of the run.
  const [liveExpanded, setLiveExpanded] = React.useState(true)
  // Historical/error trace: collapsed by default so the answer surface
  // stays clean; one click reveals the full execution trail.
  const [traceExpanded, setTraceExpanded] = React.useState(false)
  // Live elapsed counter (Claude's "Thinking · 12s"). Anchored to the
  // first live render of this bubble; ticks once per second while live.
  const liveStartRef = React.useRef<number | null>(null)
  const [elapsedSec, setElapsedSec] = React.useState(0)
  const live = !state.done && !state.error
  React.useEffect(() => {
    if (!live) return
    if (liveStartRef.current === null) liveStartRef.current = Date.now()
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - (liveStartRef.current || Date.now())) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [live])
  const elapsedLabel = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, "0")}s`
    : elapsedSec >= 3
      ? `${elapsedSec}s`
      : ""
  const summary = React.useMemo(() => summarizeAgentActivity(state), [state])
  const timelineSteps = React.useMemo(() => projectTimelineSteps(state.steps), [state.steps])
  const runningTimelineStep = React.useMemo(
    () => [...timelineSteps].reverse().find((step) => step.status === "running"),
    [timelineSteps],
  )
  const activePhase = React.useMemo(() => {
    return runningTimelineStep?.phase || phaseFromStatus(summary.status)
  }, [runningTimelineStep?.phase, summary.status])
  const taskId = state.meta?.taskId
  const canCancel = Boolean(taskId && !state.done && !state.error)
  const canRetry = Boolean(taskId && (state.error || summary.status === "cancelled"))
  const hasDeliverable = (state.artifacts?.length || 0) > 0
  const latestCheckpoint = state.checkpoints?.[state.checkpoints.length - 1]

  // ── Stale-stream guard ───────────────────────────────────────────
  // A page navigation or a backend crash can leave the persisted
  // state stuck at `done=false` even after the user's stream visibly
  // stopped (the composer's Stop button is already disabled on the
  // client). Without this guard the bubble would keep showing the
  // "pensando" placeholder forever. We arm a 90 s timer per render
  // of a live state — if the component is still mounted with
  // !state.done && !state.error after that, downgrade the local view
  // to "stale". The persisted JSON is untouched; the next event
  // delta would re-arm the live view.
  const [stale, setStale] = React.useState(false)
  React.useEffect(() => {
    setStale(false)
    if (state.done || state.error) return
    // Re-armed by lastEventAt: SSE heartbeats arrive every ~15 s, so a
    // long quiet model call no longer trips the banner — only a stream
    // that is truly dead for 90 s does.
    const id = window.setTimeout(() => setStale(true), 90_000)
    return () => window.clearTimeout(id)
  }, [state.done, state.error, state.steps.length, state.lastEventAt])

  const isLiveActivity = Boolean(!state.done && !state.error && !stale)
  const isCompletedActivity = Boolean(state.done && !state.error)
  const isStaleActivity = Boolean(stale && !state.done && !state.error)

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

  if (isCompletedActivity || hideSteps) {
    // Once the task is finished we want a clean answer surface — no
    // "Completado · N pasos · M herramientas" header and no "Ver
    // actividad" disclosure. The agent's deliverables still render
    // when present so the user can keep the file/preview, but if the
    // run produced no artifacts we render nothing here and let the
    // message body speak for itself. `hideSteps` reuses the same
    // artifacts-only surface while AgentTrace owns the live timeline.
    if (!hasDeliverable) return null
    return (
      <div className={cn("my-2 max-w-2xl space-y-1", className)}>
        {state.artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} onDocumentPreview={onDocumentPreview} />
        ))}
      </div>
    )
  }

  if (isStaleActivity) {
    // Stream went quiet (≥ 90 s) without a done/error event. The
    // composer's Stop button has long since cleared, so showing the
    // animated placeholder is a lie. Surface a minimal, recoverable
    // state instead so the user can retry or move on.
    return (
      <div className={cn("my-2 flex flex-wrap items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] text-muted-foreground", className)}>
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <span>Sin actualizaciones recientes. Puedes cancelar y volver a intentar.</span>
        {canCancel && (
          <button
            type="button"
            onClick={cancelTask}
            disabled={cancelling}
            className="ml-1 inline-flex h-6 items-center gap-1 rounded-full border border-border/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
            aria-label="Cancelar tarea"
          >
            {cancelling ? <ThinkingIndicator size="xs" /> : <Ban className="h-3 w-3" />}
            Cancelar
          </button>
        )}
      </div>
    )
  }

  if (isLiveActivity) {
    // Claude-style live activity (mirrors ThinkingTrace): a single
    // shimmering line with the current step + a live elapsed counter +
    // chevron, and a dimmed step trace behind a left rail. No box, no
    // headers, no counters — the line IS the status.
    const visibleSteps = timelineSteps.slice(-5)
    const headerLabel = runningTimelineStep?.label || summary.label
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Agente trabajando"
        className={cn("my-2.5 w-full max-w-2xl", className)}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLiveExpanded((v) => !v)}
            aria-expanded={liveExpanded}
            aria-label="Ver actividad del agente"
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left"
          >
            <DotmCircular15 size={18} className="shrink-0" ariaLabel="Trabajando" />
            <span className="thinking-shimmer-text min-w-0 truncate text-[13px] font-medium tracking-tight">
              {headerLabel}
            </span>
            {elapsedLabel && (
              <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground/55">{elapsedLabel}</span>
            )}
            {liveExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            )}
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={cancelTask}
              disabled={cancelling}
              title="Cancelar tarea"
              aria-label="Cancelar tarea"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
            >
              {cancelling ? <ThinkingIndicator size="xs" /> : <Ban className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>

        {liveExpanded && (
          <div className="mt-1 border-l border-border/50 pl-3">
            {visibleSteps.map((step) => (
              <div key={step.id} className="py-1">
                <div
                  className={cn(
                    "text-[12.5px] leading-5",
                    step.status === "running" ? "font-medium text-foreground/75" : "text-muted-foreground/80",
                    step.status === "error" && "text-red-600 dark:text-red-400",
                  )}
                >
                  {step.label}
                  {step.count > 1 && <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">×{step.count}</span>}
                </div>
                {step.detail && (
                  <div className="mt-0.5 max-w-[48rem] text-[12px] leading-5 text-muted-foreground/65">{step.detail}</div>
                )}
                <StepResearchTrace searchCalls={step.searchCalls} fetchTargets={step.fetchTargets} />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Historical / cancelled / error states — same Claude language as the
  // live trace: one quiet line with a chevron, the full trail behind it.
  return (
    <div className={cn("my-2 w-full max-w-2xl", className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTraceExpanded((v) => !v)}
          aria-expanded={traceExpanded}
          aria-label="Ver actividad del agente"
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left"
        >
          <AgentStatusIcon kind={activePhase} className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px] font-medium tracking-tight text-muted-foreground group-hover:text-foreground/80">
            {summary.label}
          </span>
          {traceExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {canCancel && (
            <button
              type="button"
              onClick={cancelTask}
              disabled={cancelling}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
            >
              {cancelling ? <ThinkingIndicator size="xs" /> : <Ban className="h-3 w-3" />}
              Cancelar
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={retryTask}
              disabled={retrying}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
            >
              {retrying ? <ThinkingIndicator size="xs" /> : <RefreshCcw className="h-3 w-3" />}
              Reintentar
            </button>
          )}
        </div>
      </div>

      {traceExpanded && (
        <div className="mt-1 border-l border-border/50 pl-3">
          {state.queue && !state.done && (
            <TimelineRow
              icon={<AgentStatusIcon kind={state.queue.status === "running" ? "working" : "queued"} className="h-4 w-4" />}
              label={state.queue.status === "queued" ? "En cola" : state.queue.status === "running" ? "Ejecutando tarea" : sanitizeAgentText(state.queue.status, "Estado de cola")}
              detail={[state.queue.queue ? `Cola ${state.queue.queue}` : null, etaLabel(state.queue.estimatedWaitMs)].filter(Boolean).join(" · ") || undefined}
              status={state.queue.status === "running" ? "running" : state.queue.status === "error" ? "error" : "muted"}
            />
          )}

          {timelineSteps.map((step) => (
            <React.Fragment key={step.id}>
              <TimelineRow
                icon={<AgentStatusIcon kind={step.status === "error" ? "error" : step.status === "done" ? "done" : step.phase} className="h-4 w-4" />}
                label={step.label}
                detail={step.detail}
                status={step.status}
                badges={step.count > 1 ? [`${step.count} pasos`] : []}
              />
              <StepResearchTrace searchCalls={step.searchCalls} fetchTargets={step.fetchTargets} />
            </React.Fragment>
          ))}

          {state.repairs?.slice(-3).map((repair) => (
            <TimelineRow
              key={`${repair.attempt}-${repair.ts || repair.message}`}
              icon={<AgentStatusIcon kind={repair.status === "completed" ? "done" : "repairing"} className="h-4 w-4" />}
              label={`Reparación automática ${repair.attempt}`}
              detail={sanitizeAgentText(repair.message, "Regenerando la entrega para corregir validaciones.")}
              status={repair.status === "completed" ? "done" : "running"}
            />
          ))}

          {(state.checkpoints?.length || 0) > 0 && (
            <div className="mt-1 flex items-center gap-2 py-1 text-xs text-muted-foreground/75">
              <Activity className="h-3.5 w-3.5" />
              <span className="min-w-0 truncate">{sanitizeAgentText(state.checkpoints[state.checkpoints.length - 1]?.label, "Progreso guardado")}</span>
            </div>
          )}

          <ValidationSummary state={state} />
        </div>
      )}

      {state.artifacts?.length > 0 && (
        <div className="mt-3 space-y-2">
          {state.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} onDocumentPreview={onDocumentPreview} />
          ))}
        </div>
      )}

      {state.error && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
          {state.error === "aborted" ? "Tarea detenida por el usuario." : state.error}
        </div>
      )}
    </div>
  )
}

export default AgenticStepsRenderer
