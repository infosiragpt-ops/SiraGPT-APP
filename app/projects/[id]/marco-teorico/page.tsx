"use client"

/**
 * /projects/:id/marco-teorico — the Marco Teórico generator page.
 *
 * Layout:
 *   ┌────────────────────┬─────────────────────────────────┐
 *   │  Config + timeline │  Live markdown preview          │
 *   │  Source chart      │  + actions (save/export) at tail│
 *   │  Source list       │                                 │
 *   └────────────────────┴─────────────────────────────────┘
 *
 * State machine:
 *   idle  → running  → done  → idle (user can regenerate)
 *                    → error (with retry)
 * Cancellation hooks the SSE stream via AbortController.
 */

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeft, Play, Square, Download, Save, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  PhaseTimeline, type PhaseKey, type PhaseState,
} from "@/components/marco-teorico/phase-timeline"
import { SourceChart } from "@/components/marco-teorico/source-chart"
import { SourceCard } from "@/components/marco-teorico/source-card"

import { projectsService, type ProjectDetail } from "@/lib/projects-service"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  generate as mtGenerate,
  save as mtSave,
  type MarcoEvent, type MarcoSource,
} from "@/lib/marco-teorico-service"

// ─── Constants ────────────────────────────────────────────────────────────

const PHASE_ORDER: PhaseKey[] = ["search", "validate", "synthesize", "format"]

type Validation = "valid" | "invalid" | "nodoi" | "pending"

// ─── Page ─────────────────────────────────────────────────────────────────

export default function MarcoTeoricoPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const router = useRouter()
  const t = useTranslations("marcoTeorico")

  // ── project fetch ────
  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [loadingProject, setLoadingProject] = React.useState(true)

  React.useEffect(() => {
    projectsService.get(projectId)
      .then(setProject)
      .catch(err => toast.error(err?.message || t("loadFailed")))
      .finally(() => setLoadingProject(false))
  }, [projectId, t])

  // ── config ────
  const [topic, setTopic] = React.useState("")
  const [yearFrom, setYearFrom] = React.useState("2020")
  const [yearTo, setYearTo] = React.useState(String(new Date().getFullYear()))
  const [limit, setLimit] = React.useState("20")
  const [lang, setLang] = React.useState<"es" | "en" | "pt" | "fr">("es")

  React.useEffect(() => {
    if (project && !topic) setTopic(project.description || project.name || "")
  }, [project, topic])

  // ── run state ────
  const [status, setStatus] = React.useState<"idle" | "running" | "done" | "error">("idle")
  const [phases, setPhases] = React.useState<Record<PhaseKey, PhaseState>>(
    () => ({
      search: { status: "pending" },
      validate: { status: "pending" },
      synthesize: { status: "pending" },
      format: { status: "pending" },
    }),
  )
  const [sources, setSources] = React.useState<MarcoSource[]>([])
  const [validations, setValidations] = React.useState<Record<number, Validation>>({})
  const [markdown, setMarkdown] = React.useState("")
  const [finalSources, setFinalSources] = React.useState<MarcoSource[]>([])
  const abortRef = React.useRef<AbortController | null>(null)

  function resetRunState() {
    setPhases({
      search: { status: "pending" },
      validate: { status: "pending" },
      synthesize: { status: "pending" },
      format: { status: "pending" },
    })
    setSources([])
    setValidations({})
    setMarkdown("")
    setFinalSources([])
  }

  function applyEvent(ev: MarcoEvent) {
    if (ev.type === "phase") {
      setPhases(prev => ({
        ...prev,
        [ev.phase]: {
          status: ev.status === "running" ? "running" : ev.status === "done" ? "done" : "error",
          detail:
            ev.status === "done"
              ? (ev.phase === "search" && typeof (ev as any).count === "number"
                  ? t("foundN", { count: (ev as any).count })
                  : ev.phase === "validate" && typeof (ev as any).valid === "number"
                  ? t("validatedN", { valid: (ev as any).valid, total: (ev as any).valid + ((ev as any).noDoi || 0) + ((ev as any).invalid || 0) })
                  : undefined)
              : ev.status === "running"
              ? t(`${ev.phase}Running` as any, { defaultMessage: "" })
              : undefined,
        },
      }))
    } else if (ev.type === "source") {
      setSources(prev => [...prev, ev.source])
    } else if (ev.type === "validation") {
      const key: Validation = ev.ok === true ? "valid" : ev.ok === "nodoi" ? "nodoi" : "invalid"
      setValidations(prev => ({ ...prev, [ev.index]: key }))
    } else if (ev.type === "synthesis_chunk") {
      setMarkdown(ev.full)
    } else if (ev.type === "final") {
      setMarkdown(ev.markdown)
      setFinalSources(ev.sources)
      setStatus("done")
    } else if (ev.type === "error") {
      const phase = (ev as any).phase as PhaseKey | undefined
      if (phase) {
        setPhases(prev => ({ ...prev, [phase]: { status: "error", error: ev.message } }))
      }
      if (ev.message !== "aborted") toast.error(ev.message)
      setStatus("error")
    }
  }

  async function handleGenerate() {
    if (!project) return
    if (!topic || topic.trim().length < 4) {
      toast.error(t("topicTooShort"))
      return
    }
    resetRunState()
    setStatus("running")
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      for await (const ev of mtGenerate({
        projectId,
        topic: topic.trim(),
        limit: Number(limit) || 20,
        yearFrom: yearFrom ? Number(yearFrom) : undefined,
        yearTo: yearTo ? Number(yearTo) : undefined,
        lang,
        signal: ctrl.signal,
      })) {
        applyEvent(ev)
      }
      // If we got here without ever hitting "final", the stream
      // ended abnormally (server 500 after first frame, etc.). Mark
      // done only if we DID get a final.
      setStatus(s => s === "running" ? "error" : s)
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast.error(err?.message || t("generateFailed"))
        setStatus("error")
      } else {
        setStatus("idle")
      }
    } finally {
      abortRef.current = null
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
  }

  async function handleSave() {
    if (!project || !markdown) return
    try {
      const chat = await mtSave({
        projectId,
        title: `Marco teórico: ${project.name}`,
        topic,
        markdown,
        sources: finalSources,
      })
      toast.success(t("savedAsChat"))
      router.push(`/chat?id=${chat.id}`)
    } catch (err: any) {
      toast.error(err?.message || t("saveFailed"))
    }
  }

  async function handleExportDocx() {
    // Client-side fallback: use the browser's Blob download with a
    // plain .md file. A full .docx export via the existing
    // /api/generate-document pipeline would be wired here once we
    // have a shared document-shape; for MVP this guarantees the
    // user always has a downloadable copy.
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `marco-teorico-${project?.name?.replace(/\s+/g, "-").toLowerCase() || "project"}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const running = status === "running"
  const labels: Record<PhaseKey, string> = {
    search: t("phase.search"),
    validate: t("phase.validate"),
    synthesize: t("phase.synthesize"),
    format: t("phase.format"),
  }

  if (loadingProject) {
    return <div className="min-h-screen flex items-center justify-center"><ThinkingIndicator size="md" /></div>
  }
  if (!project) {
    return <div className="p-10 text-center text-muted-foreground">{t("projectNotFound")}</div>
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 md:px-8 py-6 md:py-10">
        <button
          onClick={() => router.push(`/projects/${projectId}`)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("backToProject", { name: project.name })}
        </button>

        <header className="mb-6">
          <h1 className="text-3xl font-serif tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{t("subtitle")}</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
          {/* ─── Left column: config + timeline + sources ────────────────── */}
          <div className="space-y-4">
            {/* Config */}
            <div className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
              <div>
                <Label htmlFor="mt-topic" className="text-xs">{t("topic")}</Label>
                <Input
                  id="mt-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  disabled={running}
                  placeholder={t("topicPlaceholder")}
                  className="mt-1 h-9 text-sm"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label htmlFor="mt-from" className="text-xs">{t("yearFrom")}</Label>
                  <Input id="mt-from" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} disabled={running} type="number" className="mt-1 h-9 text-sm tabular-nums" />
                </div>
                <div>
                  <Label htmlFor="mt-to" className="text-xs">{t("yearTo")}</Label>
                  <Input id="mt-to" value={yearTo} onChange={(e) => setYearTo(e.target.value)} disabled={running} type="number" className="mt-1 h-9 text-sm tabular-nums" />
                </div>
                <div>
                  <Label htmlFor="mt-limit" className="text-xs">{t("sources")}</Label>
                  <Input id="mt-limit" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={running} type="number" min={5} max={60} className="mt-1 h-9 text-sm tabular-nums" />
                </div>
              </div>
              <div>
                <Label htmlFor="mt-lang" className="text-xs">{t("language")}</Label>
                <Select value={lang} onValueChange={(v: any) => setLang(v)} disabled={running}>
                  <SelectTrigger id="mt-lang" className="mt-1 h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="pt">Português</SelectItem>
                    <SelectItem value="fr">Français</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {running ? (
                <Button onClick={handleCancel} variant="outline" className="w-full gap-2">
                  <Square className="h-4 w-4" />
                  {t("cancel")}
                </Button>
              ) : (
                <Button onClick={handleGenerate} className="w-full gap-2">
                  {status === "done" || status === "error" ? <RefreshCw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {status === "done" || status === "error" ? t("regenerate") : t("generate")}
                </Button>
              )}
            </div>

            {/* Timeline (always visible so the 4 phases frame expectations) */}
            <div className="rounded-xl border border-border/60 bg-card p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-3">
                {t("pipeline")}
              </div>
              <PhaseTimeline phases={phases} labels={labels} />
            </div>

            {/* Source chart — appears once we have sources */}
            {sources.length > 0 && (
              <SourceChart sources={sources} label={t("yearDistribution")} />
            )}

            {/* Source list */}
            {sources.length > 0 && (
              <div className="rounded-xl border border-border/60 bg-card p-3 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 px-1 pb-1">
                  {t("sourcesFound", { count: sources.length })}
                </div>
                <div className="space-y-1.5 max-h-[480px] overflow-y-auto custom-scrollbar">
                  {sources.map((s, i) => (
                    <SourceCard key={s.id || i} source={s} validation={validations[i] || "pending"} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ─── Right column: preview ────────────────────────────────────── */}
          <div className="rounded-xl border border-border/60 bg-card min-h-[540px] flex flex-col">
            <div className="border-b border-border/60 px-5 py-3 flex items-center justify-between">
              <div className="text-sm font-semibold">{t("preview")}</div>
              {status === "done" && markdown && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleExportDocx} className="gap-1.5 h-8">
                    <Download className="h-3.5 w-3.5" />
                    {t("export")}
                  </Button>
                  <Button size="sm" onClick={handleSave} className="gap-1.5 h-8">
                    <Save className="h-3.5 w-3.5" />
                    {t("saveAsChat")}
                  </Button>
                </div>
              )}
            </div>
            <div className="flex-1 p-5 overflow-y-auto custom-scrollbar">
              {!markdown && status === "idle" && (
                <div className="h-full flex items-center justify-center text-center text-sm text-muted-foreground max-w-md mx-auto">
                  {t("emptyPreview")}
                </div>
              )}
              {!markdown && running && (
                <div className="text-sm text-muted-foreground animate-pulse">
                  {t("warmingUp")}
                </div>
              )}
              {markdown && (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
