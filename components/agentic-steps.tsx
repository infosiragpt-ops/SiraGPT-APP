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
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentTaskState, AgenticIcon, AgentArtifact } from "@/lib/agent-task-service"

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
    if (tool === "web_search") return "Search"
    if (tool === "rag_retrieve") return "RAG"
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
    <a
      href={href}
      download={a.filename}
      target="_blank"
      rel="noreferrer"
      className="mt-2 flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2 transition-colors hover:bg-muted/40"
    >
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{a.filename}</div>
        <div className="text-[11px] text-muted-foreground">
          {a.mime} · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
        </div>
      </div>
      <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
    </a>
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
          ❌ {state.error}
        </div>
      )}
    </div>
  )
}

export default AgenticStepsRenderer
