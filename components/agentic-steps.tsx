"use client"

/**
 * AgenticStepsRenderer — Claude-style step cards.
 *
 * Each step is a collapsible tile with:
 *   - status icon (running spinner / ✓ done / ✕ error)
 *   - one-line label (the agent's "thought" or the tool it's about to call)
 *   - optional badge ("Script" / "Python" / "Bash" / "Search" / "Doc")
 *   - optional code preview (syntax highlighted)
 *   - optional tool-output preview (mono, dimmer)
 *   - optional artifact card (download button)
 *
 * Rendered text uses the Claude visual hierarchy:
 *   - title:        text-foreground (full contrast, near-black)
 *   - body / preview: text-muted-foreground (subdued)
 *
 * The component is fully controlled — caller owns the AgentTaskState
 * and just hands it in. No internal fetching.
 */

import * as React from "react"
import {
  Loader2, Check, X, ChevronDown, ChevronRight,
  Terminal, FileCode, Search, FileText, Download, Sparkles, ShieldCheck,
  Clock3, RefreshCcw, ExternalLink, FileCheck2, Activity,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { agentTaskService, type AgentTaskState, type AgenticIcon, type AgentArtifact } from "@/lib/agent-task-service"

interface Props {
  state: AgentTaskState
  className?: string
}

const ICON_MAP: Record<AgenticIcon, React.ComponentType<{ className?: string }>> = {
  python: FileCode,
  bash: Terminal,
  search: Search,
  doc: FileText,
  verify: ShieldCheck,
  thought: Sparkles,
  check: Check,
}

function IconForStep({ icon, status }: { icon?: AgenticIcon; status: "running" | "done" | "error" }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  if (status === "error") return <X className="h-4 w-4 text-red-500" />
  if (status === "done") return <Check className="h-4 w-4 text-emerald-600" />
  const Icon = icon ? ICON_MAP[icon] : Sparkles
  return <Icon className="h-4 w-4 text-muted-foreground" />
}

function ToolBadge({ tool, language }: { tool: string; language?: string }) {
  const label = (() => {
    if (language === "python") return "Python"
    if (language === "javascript") return "JavaScript"
    if (language === "bash") return "Bash"
    if (tool === "create_document") return "Script"
    if (tool === "verify_artifact") return "Verify"
    if (tool === "run_tests") return "Tests"
    if (tool === "web_search") return "Search"
    if (tool === "rag_retrieve") return "RAG"
    if (tool === "self_rag_answer") return "Self-RAG"
    return tool
  })()
  return (
    <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  )
}

function CodePreview({ code, language }: { code: string; language?: string }) {
  if (!code) return null
  return (
    <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-[12px] leading-snug text-foreground/90">
      <code className={language ? `language-${language}` : undefined}>{code}</code>
    </pre>
  )
}

function ToolOutputPreview({ ok, preview }: { ok: boolean; preview: string }) {
  if (!preview) return null
  return (
    <div className={cn(
      "mt-1 rounded-md border px-2 py-1 text-[11px] leading-snug font-mono whitespace-pre-wrap",
      ok ? "border-border/30 bg-muted/20 text-muted-foreground" : "border-red-200/60 bg-red-50/40 text-red-700 dark:bg-red-950/20 dark:text-red-300",
    )}>
      {preview}
    </div>
  )
}

function ArtifactCard({ a }: { a: AgentArtifact }) {
  const apiRoot = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
  const href = a.downloadUrl.startsWith("http") ? a.downloadUrl : `${apiRoot.replace(/\/api$/, "")}${a.downloadUrl}`
  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background px-3 py-2">
      <div className="flex items-center gap-3">
      <FileCheck2 className="h-5 w-5 shrink-0 text-emerald-600" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{a.filename}</div>
        <div className="text-[11px] text-muted-foreground">
          {a.mime} · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
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
        <a
          href={href}
          download={a.filename}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Descargar documento"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
      </div>
      {a.previewHtml && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border/40 bg-muted/10">
          <div dangerouslySetInnerHTML={{ __html: a.previewHtml }} />
        </div>
      )}
    </div>
  )
}

function StepCard({
  step,
  artifacts,
  defaultOpen,
}: {
  step: AgentTaskState["steps"][number]
  artifacts: AgentArtifact[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen) || step.status === "running")

  // Auto-open while running, auto-collapse once done IF the user hasn't
  // manually toggled. We track a manual flag so user choice wins.
  const userToggled = React.useRef(false)
  React.useEffect(() => {
    if (userToggled.current) return
    if (step.status === "running") setOpen(true)
    else if (step.status === "done") setOpen(false)
    else if (step.status === "error") setOpen(true)
  }, [step.status])

  const hasDetail = step.toolCalls.length > 0
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => { userToggled.current = true; setOpen(o => !o) }}
        className="flex w-full items-start gap-2 rounded-md py-1.5 text-left transition-colors hover:bg-muted/30"
        disabled={!hasDetail}
      >
        <span className="mt-0.5 shrink-0">
          <IconForStep icon={step.icon} status={step.status} />
        </span>
        <span className={cn(
          "flex-1 text-[13px] leading-snug",
          step.status === "done" ? "text-foreground" : "text-foreground",
        )}>
          {step.label}
        </span>
        {hasDetail && (
          <Chevron className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform" />
        )}
      </button>

      {open && hasDetail && (
        <div className="ml-6 mt-1 space-y-2 border-l border-border/40 pl-3">
          {step.toolCalls.map((call, idx) => (
            <div key={idx}>
              <div className="flex items-center gap-2 text-[12px]">
                <ToolBadge tool={call.tool} language={call.language} />
                <span className="text-muted-foreground truncate">{call.preview}</span>
              </div>
              {call.codePreview && <CodePreview code={call.codePreview} language={call.language} />}
              {call.output && <ToolOutputPreview ok={call.output.ok} preview={call.output.preview} />}
              {call.tool === "create_document" && call.output?.ok && (
                artifacts
                  .filter(a => call.output && call.output.preview.includes(a.filename))
                  .map(a => <ArtifactCard key={a.id} a={a} />)
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AgenticStepsRenderer({ state, className }: Props) {
  const [retrying, setRetrying] = React.useState(false)
  const retryTask = React.useCallback(async () => {
    const taskId = state.meta?.taskId
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
  }, [retrying, state.meta?.taskId])

  // Artifacts that didn't get matched to a specific step go in a tail
  // section so the user can always find their downloads.
  const matchedFilenames = new Set<string>()
  for (const step of state.steps) {
    for (const call of step.toolCalls) {
      if (call.tool === "create_document" && call.output?.ok) {
        for (const a of state.artifacts) {
          if (call.output.preview.includes(a.filename)) matchedFilenames.add(a.id)
        }
      }
    }
  }
  const unmatchedArtifacts = state.artifacts.filter(a => !matchedFilenames.has(a.id))

  return (
    <div className={cn("space-y-1.5", className)}>
      {(state.queue || state.documentPolicy || state.frameworks || state.approvals?.length > 0) && (
        <div className="mb-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            {state.queue && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 font-medium text-foreground">
                {state.queue.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
                {state.queue.status === "queued" ? "En cola" : state.queue.status === "running" ? "Ejecutando" : state.queue.status}
              </span>
            )}
            {state.documentPolicy && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
                <FileText className="h-3.5 w-3.5" />
                {state.documentPolicy.mode === "doc_required" ? "Documento automático" : state.documentPolicy.mode === "doc_suggested" ? "Documento sugerido" : "Chat"}
                <span className="font-semibold uppercase text-foreground">{state.documentPolicy.format}</span>
              </span>
            )}
            {state.queue?.queue && (
              <span className="truncate">Queue: {state.queue.queue}</span>
            )}
            {state.frameworks?.active && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
                <Activity className="h-3.5 w-3.5" />
                Stack
                <span className="font-semibold text-foreground">
                  {String((state.frameworks.active as any).orchestration || "agentic")}
                </span>
              </span>
            )}
            {state.approvals?.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
                <ShieldCheck className="h-3.5 w-3.5" />
                HITL
                <span className="font-semibold text-foreground">
                  {state.approvals.filter(a => a.status === "pending").length} pendientes
                </span>
              </span>
            )}
          </div>
          {state.documentPolicy?.reason && (
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{state.documentPolicy.reason}</div>
          )}
        </div>
      )}

      {(state.checkpoints?.length > 0 || state.qualityGates?.length > 0 || state.repairs?.length > 0) && (
        <div className="mb-2 grid gap-2 sm:grid-cols-3">
          {state.checkpoints?.length > 0 && (
            <div className="rounded-md border border-border/50 bg-background px-2.5 py-2 text-[11px]">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <Activity className="h-3.5 w-3.5" />
                Checkpoints
              </div>
              <div className="truncate text-muted-foreground">{state.checkpoints[state.checkpoints.length - 1]?.label}</div>
            </div>
          )}
          {state.qualityGates?.length > 0 && (
            <div className="rounded-md border border-border/50 bg-background px-2.5 py-2 text-[11px]">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                Validación
              </div>
              <div className="truncate text-muted-foreground">
                {state.qualityGates.filter(g => g.passed).length}/{state.qualityGates.length} gates aprobados
              </div>
            </div>
          )}
          {state.repairs?.length > 0 && (
            <div className="rounded-md border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <RefreshCcw className="h-3.5 w-3.5" />
                Reparación
              </div>
              <div className="truncate">{state.repairs[state.repairs.length - 1]?.message}</div>
            </div>
          )}
        </div>
      )}

      {state.steps.map(step => (
        <StepCard
          key={step.id}
          step={step}
          artifacts={state.artifacts}
        />
      ))}

      {unmatchedArtifacts.length > 0 && (
        <div className="mt-2 space-y-2">
          {unmatchedArtifacts.map(a => <ArtifactCard key={a.id} a={a} />)}
        </div>
      )}

      {state.error && (
        <div className="mt-2 rounded-md border border-red-200/60 bg-red-50/50 p-3 text-[12px] text-red-700 dark:bg-red-950/20 dark:text-red-300">
          <div className="flex items-start justify-between gap-3">
            <span>{state.error}</span>
            {state.meta?.taskId && (
              <button
                type="button"
                onClick={retryTask}
                disabled={retrying}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200/70 bg-background/80 px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60 dark:bg-red-950/20 dark:text-red-200"
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
                Reintentar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default AgenticStepsRenderer
