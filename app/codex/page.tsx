"use client"

import * as React from "react"
import useSWR from "swr"
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  Code2,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  Github,
  Globe,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  githubCodexService,
  type GitHubCodexActionFailureAnalysisResult,
  type GitHubCodexActionRunsResult,
  type GitHubCodexContext,
  type GitHubCodexRagIngestResult,
  type GitHubCodexRagSearchResult,
  type GitHubCodexStatus,
  type GitHubCodexWorkflowRun,
} from "@/lib/github-codex-service"

const DEFAULT_REPO = "SiraGPT-ORg/siraGPT"
const DEFAULT_BRANCH = "main"
const DEFAULT_BROWSER_URL = "http://localhost:3000/chat"

type RightView = "browser" | "actions" | "repository" | "rag"

function formatDate(value: string | null | undefined) {
  if (!value) return "Sin fecha"
  try {
    return new Intl.DateTimeFormat("es", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value))
  } catch {
    return value
  }
}

function formatDuration(ms?: number | null) {
  if (!ms) return "Sin duración"
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function normalizeBrowserUrl(value: string) {
  const raw = value.trim()
  if (!raw) return getDefaultBrowserUrl()
  if (raw.startsWith("/")) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`
  return `https://${raw}`
}

function getDefaultBrowserUrl() {
  if (typeof window !== "undefined") return `${window.location.origin}/chat`
  return DEFAULT_BROWSER_URL
}

function runTone(run?: GitHubCodexWorkflowRun | null) {
  if (!run) return "border-border bg-muted/20 text-muted-foreground"
  if (run.conclusion === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300"
  if (run.conclusion) return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300"
  return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
}

function healthDot(run?: GitHubCodexWorkflowRun | null) {
  if (!run) return "bg-muted-foreground/50"
  if (run.conclusion === "success") return "bg-emerald-500"
  if (run.conclusion) return "bg-red-500"
  return "bg-amber-500"
}

export default function CodexPage() {
  const [repo, setRepo] = React.useState(DEFAULT_REPO)
  const [branch, setBranch] = React.useState(DEFAULT_BRANCH)
  const [inspectRequest, setInspectRequest] = React.useState<{ repo: string; branch: string; nonce: number } | null>(null)
  const [rightView, setRightView] = React.useState<RightView>("browser")
  const [browserInput, setBrowserInput] = React.useState(DEFAULT_BROWSER_URL)
  const [browserUrl, setBrowserUrl] = React.useState(DEFAULT_BROWSER_URL)
  const [ragIndexing, setRagIndexing] = React.useState(false)
  const [ragSearching, setRagSearching] = React.useState(false)
  const [ragQuery, setRagQuery] = React.useState("¿Dónde se implementa el chat y el streaming?")
  const [ragIngest, setRagIngest] = React.useState<GitHubCodexRagIngestResult | null>(null)
  const [ragSearch, setRagSearch] = React.useState<GitHubCodexRagSearchResult | null>(null)
  const [actionAnalysis, setActionAnalysis] = React.useState<GitHubCodexActionFailureAnalysisResult | null>(null)
  const [analyzingRunId, setAnalyzingRunId] = React.useState<number | null>(null)

  const {
    data: status = null,
    error: statusError,
    isLoading: statusLoading,
  } = useSWR<GitHubCodexStatus>("github-codex-status", () => githubCodexService.status(), {
    dedupingInterval: 60_000,
    revalidateOnFocus: false,
  })

  const {
    data: context = null,
    error: contextError,
    isLoading: contextLoading,
  } = useSWR<GitHubCodexContext>(
    inspectRequest ? ["github-codex-context", inspectRequest.repo, inspectRequest.branch, inspectRequest.nonce] : null,
    ([, requestRepo, requestBranch]) => githubCodexService.inspectRepository({
      repo: String(requestRepo),
      branch: String(requestBranch || "") || undefined,
      limit: 10,
    }),
    {
      dedupingInterval: 15_000,
      revalidateOnFocus: false,
    },
  )

  const {
    data: actions = null,
    error: actionsError,
    isLoading: actionsLoading,
  } = useSWR<GitHubCodexActionRunsResult>(
    inspectRequest ? ["github-codex-actions", inspectRequest.repo, inspectRequest.branch, inspectRequest.nonce] : null,
    ([, requestRepo, requestBranch]) => githubCodexService.listActionRuns({
      repo: String(requestRepo),
      branch: String(requestBranch || "") || undefined,
      limit: 12,
    }),
    {
      dedupingInterval: 15_000,
      revalidateOnFocus: false,
    },
  )

  React.useEffect(() => {
    setInspectRequest({ repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, nonce: 1 })
  }, [])

  React.useEffect(() => {
    const sameOriginChat = getDefaultBrowserUrl()
    setBrowserInput((current) => current === DEFAULT_BROWSER_URL ? sameOriginChat : current)
    setBrowserUrl((current) => current === DEFAULT_BROWSER_URL ? sameOriginChat : current)
  }, [])

  React.useEffect(() => {
    if (statusError) toast.error(statusError?.message || "No se pudo leer el estado de GitHub")
  }, [statusError])

  React.useEffect(() => {
    if (contextError) toast.error(contextError?.message || "No se pudo inspeccionar el repositorio")
  }, [contextError])

  React.useEffect(() => {
    if (actionsError) toast.error(actionsError?.message || "No se pudo leer GitHub Actions")
  }, [actionsError])

  const latestRun = actions?.runs[0] || context?.workflowRuns[0] || null
  const activeRepo = context?.repository.fullName || actions?.repository.fullName || repo
  const activeBranch = context?.branch || actions?.branch || branch
  const busy = contextLoading || actionsLoading

  const inspect = React.useCallback((view: RightView = "actions") => {
    const cleanRepo = repo.trim()
    if (!cleanRepo) {
      toast.error("Indica un repositorio GitHub")
      return
    }
    setRightView(view)
    setActionAnalysis(null)
    setInspectRequest((previous) => ({
      repo: cleanRepo,
      branch: branch.trim() || DEFAULT_BRANCH,
      nonce: (previous?.nonce || 0) + 1,
    }))
  }, [branch, repo])

  const openBrowser = React.useCallback(() => {
    const next = normalizeBrowserUrl(browserInput)
    setBrowserInput(next)
    setBrowserUrl(next)
    setRightView("browser")
  }, [browserInput])

  const indexRepository = React.useCallback(async () => {
    const cleanRepo = repo.trim()
    if (!cleanRepo) {
      toast.error("Indica un repositorio GitHub")
      return
    }
    setRightView("rag")
    setRagIndexing(true)
    try {
      const next = await githubCodexService.ingestRepository({
        repo: cleanRepo,
        branch: branch.trim() || context?.branch || undefined,
        limit: 45,
        maxBytes: 60000,
      })
      setRagIngest(next)
      setRagSearch(null)
      toast.success(`RAG indexado: ${next.filesIndexed} archivos, ${next.chunksAdded} chunks`)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo indexar el repositorio")
    } finally {
      setRagIndexing(false)
    }
  }, [branch, context?.branch, repo])

  const searchRepository = React.useCallback(async () => {
    const cleanQuery = ragQuery.trim()
    if (!cleanQuery) {
      toast.error("Escribe una pregunta para buscar en el repo")
      return
    }
    setRightView("rag")
    setRagSearching(true)
    try {
      const next = await githubCodexService.searchRepositoryContext({
        query: cleanQuery,
        repo: repo.trim(),
        branch: branch.trim() || context?.branch || undefined,
        collection: ragIngest?.collection,
        k: 5,
      })
      setRagSearch(next)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo buscar contexto RAG")
    } finally {
      setRagSearching(false)
    }
  }, [branch, context?.branch, ragIngest?.collection, ragQuery, repo])

  const analyzeRun = React.useCallback(async (run: GitHubCodexWorkflowRun | null | undefined) => {
    if (!run?.id) {
      toast.error("No hay run de GitHub Actions para analizar")
      return
    }
    setRightView("actions")
    setAnalyzingRunId(run.id)
    try {
      const result = await githubCodexService.analyzeActionFailure({
        repo: repo.trim() || activeRepo,
        runId: run.id,
        includeLogs: true,
        maxLogBytes: 60000,
      })
      setActionAnalysis(result)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo analizar el run")
    } finally {
      setAnalyzingRunId(null)
    }
  }, [activeRepo, repo])

  return (
    <main className="flex h-full min-h-0 w-full bg-background text-foreground">
      <aside className="flex w-full min-w-[320px] max-w-[420px] flex-col border-r border-border/70 bg-background">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/30">
            <Code2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Codex</div>
            <div className="truncate text-xs text-muted-foreground">GitHub Actions Intelligence</div>
          </div>
          <Badge variant="outline" className={cn("ml-auto h-7 rounded-md", runTone(latestRun))}>
            <span className={cn("mr-1.5 h-2 w-2 rounded-full", healthDot(latestRun))} />
            {latestRun?.conclusion || latestRun?.status || "standby"}
          </Badge>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <div className="space-y-3">
            <CodexMessage role="Sistema">
              Conector GitHub en modo read-only. Token solo desde backend, logs truncados y sanitizados.
            </CodexMessage>
            <CodexMessage role="Indicación">
              Vigila CI de <span className="font-medium">{activeRepo}</span>, resume fallos y deja el navegador local visible a la derecha.
            </CodexMessage>
            {latestRun ? (
              <CodexMessage role="CI">
                Último run: <span className="font-medium">{latestRun.name}</span> · {latestRun.conclusion || latestRun.status} · {formatDate(latestRun.updatedAt)}
              </CodexMessage>
            ) : null}
            {actionAnalysis ? (
              <CodexMessage role="Diagnóstico">
                {actionAnalysis.analysis.rootCauseCandidates[0] || "Sin causa raíz accionable visible."}
              </CodexMessage>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
              <label className="min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Repositorio</span>
                <div className="relative">
                  <Github className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") inspect("actions")
                    }}
                    className="h-9 rounded-md pl-9"
                  />
                </div>
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Branch</span>
                <div className="relative">
                  <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") inspect("actions")
                    }}
                    className="h-9 rounded-md pl-9"
                  />
                </div>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button type="button" onClick={() => inspect("actions")} disabled={busy} className="h-9 rounded-md">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Revisar CI
              </Button>
              <Button type="button" variant="outline" onClick={() => analyzeRun(latestRun)} disabled={!latestRun || Boolean(analyzingRunId)} className="h-9 rounded-md">
                {analyzingRunId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
                Analizar fallo
              </Button>
            </div>

            <div className="rounded-md border border-border bg-muted/15 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                GitHub
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <StatusCell label="Modo" value={status?.configured ? "Token backend" : "Público"} />
                <StatusCell label="Runs" value={String(actions?.summary.totalRuns ?? context?.workflowRuns.length ?? 0)} />
                <StatusCell label="Fallos" value={String(actions?.summary.failingRuns ?? 0)} />
                <StatusCell label="Rama" value={activeBranch} />
              </div>
            </div>

            <div className="rounded-md border border-border bg-muted/15 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Globe className="h-3.5 w-3.5" />
                Navegador
              </div>
              <div className="flex gap-2">
                <Input
                  value={browserInput}
                  onChange={(event) => setBrowserInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openBrowser()
                  }}
                  className="h-9 rounded-md"
                />
                <Button type="button" size="icon" variant="secondary" onClick={openBrowser} className="h-9 w-9 shrink-0 rounded-md" aria-label="Abrir URL">
                  <ArrowUp className="h-4 w-4 rotate-45" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-border/70 p-3">
          <div className="flex gap-2">
            <Input
              value={ragQuery}
              onChange={(event) => setRagQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") searchRepository()
              }}
              placeholder="Pregunta sobre el repo"
              className="h-10 rounded-md"
            />
            <Button type="button" size="icon" onClick={searchRepository} disabled={ragSearching} className="h-10 w-10 shrink-0 rounded-md" aria-label="Buscar en RAG">
              {ragSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-muted/10">
        <BrowserChrome
          view={rightView}
          setView={setRightView}
          browserUrl={browserUrl}
          latestRun={latestRun}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          {rightView === "browser" ? (
            <BrowserPane url={browserUrl} />
          ) : rightView === "actions" ? (
            <ActionsPane
              actions={actions}
              analysis={actionAnalysis}
              loading={actionsLoading}
              analyzingRunId={analyzingRunId}
              onAnalyze={analyzeRun}
            />
          ) : rightView === "repository" ? (
            <RepositoryPane context={context} loading={contextLoading} />
          ) : (
            <RagPane
              context={context}
              ingest={ragIngest}
              search={ragSearch}
              indexing={ragIndexing}
              searching={ragSearching}
              onIndex={indexRepository}
              onSearch={searchRepository}
            />
          )}
        </div>
      </section>
    </main>
  )
}

function CodexMessage({ role, children }: { role: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-3 text-sm leading-6">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{role}</div>
      <div className="text-foreground/90">{children}</div>
    </div>
  )
}

function StatusCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-medium">{value}</div>
    </div>
  )
}

function BrowserChrome({
  view,
  setView,
  browserUrl,
  latestRun,
}: {
  view: RightView
  setView: (view: RightView) => void
  browserUrl: string
  latestRun: GitHubCodexWorkflowRun | null
}) {
  const tabs: Array<{ id: RightView; label: string; icon: React.ElementType }> = [
    { id: "browser", label: "Navegador", icon: Monitor },
    { id: "actions", label: "CI", icon: Activity },
    { id: "repository", label: "Repo", icon: Github },
    { id: "rag", label: "RAG", icon: Database },
  ]
  return (
    <div className="shrink-0 border-b border-border/70 bg-background">
      <div className="flex h-10 items-center gap-1 border-b border-border/60 px-3">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                view === tab.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}
        <Badge variant="outline" className={cn("ml-auto h-7 rounded-md", runTone(latestRun))}>
          <span className={cn("mr-1.5 h-2 w-2 rounded-full", healthDot(latestRun))} />
          {latestRun?.conclusion || latestRun?.status || "sin CI"}
        </Badge>
      </div>
      <div className="flex h-10 items-center gap-2 px-3 text-xs text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
        <div className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/20 px-3 py-1.5 font-mono">
          {view === "browser" ? browserUrl : "github.com/actions"}
        </div>
        {view === "browser" ? (
          <Button variant="ghost" size="sm" asChild className="h-7 rounded-md px-2">
            <a href={browserUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function BrowserPane({ url }: { url: string }) {
  return (
    <div className="h-full min-h-0 bg-background">
      <iframe
        key={url}
        src={url}
        title="Codex browser"
        className="h-full w-full border-0 bg-background"
      />
    </div>
  )
}

function ActionsPane({
  actions,
  analysis,
  loading,
  analyzingRunId,
  onAnalyze,
}: {
  actions: GitHubCodexActionRunsResult | null
  analysis: GitHubCodexActionFailureAnalysisResult | null
  loading: boolean
  analyzingRunId: number | null
  onAnalyze: (run: GitHubCodexWorkflowRun) => void
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-[1280px] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 p-4">
            <Activity className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-semibold">GitHub Actions</h2>
            {loading ? <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
          <div className="divide-y divide-border/60">
            {actions?.runs.length ? actions.runs.map((run) => (
              <div key={run.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", healthDot(run))} />
                    <div className="truncate text-sm font-medium">{run.name}</div>
                    <Badge variant="outline" className={cn("rounded-md", runTone(run))}>
                      {run.conclusion || run.status || "unknown"}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {run.displayTitle || run.event} · {run.branch || actions.branch} · {run.headSha || "sin sha"} · {formatDuration(run.durationMs)}
                  </div>
                  {run.headCommit?.message ? (
                    <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{run.headCommit.message}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onAnalyze(run)} disabled={analyzingRunId === run.id} className="h-8 rounded-md">
                    {analyzingRunId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />}
                    Analizar
                  </Button>
                  <Button variant="ghost" size="sm" asChild className="h-8 rounded-md px-2">
                    <a href={run.htmlUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </div>
            )) : (
              <div className="p-6 text-sm text-muted-foreground">
                {loading ? "Leyendo GitHub Actions..." : "No hay runs visibles para este repositorio."}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 p-4">
            {analysis?.analysis.health === "red" ? <XCircle className="h-4 w-4 text-red-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            <h2 className="text-sm font-semibold">Diagnóstico</h2>
          </div>
          {analysis ? (
            <div className="space-y-4 p-4">
              <div className="rounded-md border border-border bg-muted/15 p-3">
                <div className="text-xs font-medium text-muted-foreground">Run</div>
                <div className="mt-1 text-sm font-semibold">{analysis.run.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{analysis.run.conclusion || analysis.run.status}</div>
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Causa probable</div>
                <div className="space-y-2">
                  {analysis.analysis.rootCauseCandidates.length ? analysis.analysis.rootCauseCandidates.map((item) => (
                    <div key={item} className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5">
                      {item}
                    </div>
                  )) : (
                    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                      Sin línea de error accionable en los logs disponibles.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Siguiente acción</div>
                <div className="space-y-2">
                  {analysis.analysis.nextActions.map((item) => (
                    <div key={item} className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              {analysis.logs.excerpts.length ? (
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Log sanitizado</div>
                  <pre className="max-h-[320px] overflow-auto rounded-md border border-border bg-background p-3 text-[11px] leading-5 text-muted-foreground">
                    {analysis.logs.excerpts.map((entry) => `# ${entry.jobName}\n${entry.excerpt}`).join("\n\n")}
                  </pre>
                </div>
              ) : null}

              {analysis.analysis.warnings.length ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Contexto parcial
                  </div>
                  <ul className="mt-2 space-y-1">
                    {analysis.analysis.warnings.map((warning) => (
                      <li key={`${warning.area}-${warning.code}`}>{warning.area}: {warning.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="p-6 text-sm leading-6 text-muted-foreground">
              Selecciona un run para ver jobs, steps fallidos y señales sanitizadas de logs.
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function RepositoryPane({ context, loading }: { context: GitHubCodexContext | null; loading: boolean }) {
  if (loading) {
    return <CenteredState icon={Loader2} label="Leyendo repositorio" spin />
  }
  if (!context) {
    return <CenteredState icon={Github} label="Ejecuta Revisar CI para cargar el repositorio" />
  }
  const repo = context.repository
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-[1120px] space-y-4">
        <section className="rounded-md border border-border bg-card">
          <div className="flex items-start gap-3 border-b border-border/60 p-4">
            <Github className="mt-1 h-5 w-5 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-normal">{repo.fullName}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{repo.description || "Sin descripción"}</p>
            </div>
            <Button variant="outline" size="sm" asChild className="ml-auto h-8 rounded-md">
              <a href={repo.htmlUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                GitHub
              </a>
            </Button>
          </div>
          <div className="grid gap-px bg-border/60 sm:grid-cols-4">
            <Metric label="Lenguaje" value={repo.language} />
            <Metric label="Branch" value={context.branch || repo.defaultBranch} />
            <Metric label="PRs" value={String(context.pullRequests.length)} />
            <Metric label="Issues" value={String(context.issues.length)} />
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 p-4">
            <FileText className="h-4 w-4 text-indigo-600" />
            <h2 className="text-sm font-semibold">README</h2>
          </div>
          {context.readme ? (
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap p-4 text-xs leading-5 text-muted-foreground">
              {context.readme.preview}
              {context.readme.truncated ? "\n\n[preview truncado]" : ""}
            </pre>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">README no visible en este branch.</div>
          )}
        </section>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  )
}

function RagPane({
  context,
  ingest,
  search,
  indexing,
  searching,
  onIndex,
  onSearch,
}: {
  context: GitHubCodexContext | null
  ingest: GitHubCodexRagIngestResult | null
  search: GitHubCodexRagSearchResult | null
  indexing: boolean
  searching: boolean
  onIndex: () => void
  onSearch: () => void
}) {
  const activeCollection = ingest?.collection || (context ? `github:${context.repository.fullName}:${context.branch}` : "Sin colección")
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-[1120px] space-y-4">
        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 p-4">
            <Database className="h-4 w-4 text-cyan-600" />
            <h2 className="text-sm font-semibold">RAG de repositorio</h2>
            <Badge variant="outline" className="ml-auto rounded-md">
              {ingest ? `${ingest.totalChunks} chunks` : "No indexado"}
            </Badge>
          </div>
          <div className="space-y-4 p-4">
            <div className="break-all rounded-md border border-border bg-muted/15 p-3 text-xs font-medium">
              {activeCollection}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={onIndex} disabled={indexing} className="h-9 rounded-md">
                {indexing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                Indexar
              </Button>
              <Button type="button" onClick={onSearch} disabled={searching} className="h-9 rounded-md">
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Buscar
              </Button>
            </div>
            {ingest ? (
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <StatusCell label="Archivos" value={String(ingest.filesIndexed)} />
                <StatusCell label="Chunks" value={String(ingest.totalChunks)} />
                <StatusCell label="KB" value={String(Math.round(ingest.bytesIndexed / 1024))} />
                <StatusCell label="Omitidos" value={String(ingest.skipped.oversized + ingest.skipped.fetchFailed)} />
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 p-4">
            <Search className="h-4 w-4 text-blue-600" />
            <h2 className="text-sm font-semibold">Resultados</h2>
          </div>
          <div className="space-y-3 p-4">
            {search?.hits.length ? search.hits.map((hit, index) => (
              <div key={`${hit.source}-${index}`} className="rounded-md border border-border bg-background p-3">
                <div className="truncate text-xs font-semibold">{hit.title || hit.source || "fragmento"}</div>
                <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{hit.text}</p>
              </div>
            )) : (
              <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
                Sin resultados todavía.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function CenteredState({ icon: Icon, label, spin = false }: { icon: React.ElementType; label: string; spin?: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="space-y-3">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card">
          <Icon className={cn("h-5 w-5 text-muted-foreground", spin && "animate-spin")} />
        </div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
