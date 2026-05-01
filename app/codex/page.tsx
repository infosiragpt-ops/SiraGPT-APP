"use client"

import * as React from "react"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Code2,
  ExternalLink,
  FileText,
  GitBranch,
  GitFork,
  Github,
  GitPullRequest,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Star,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  githubCodexService,
  type GitHubCodexContext,
  type GitHubCodexStatus,
} from "@/lib/github-codex-service"

const DEFAULT_REPO = "SiraGPT-ORg/siraGPT"

function formatDate(value: string | null) {
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

function healthLabel(health?: GitHubCodexContext["codexSummary"]["health"]) {
  if (health === "needs_attention") return "Revisar"
  if (health === "partial") return "Parcial"
  return "Listo"
}

function healthClass(health?: GitHubCodexContext["codexSummary"]["health"]) {
  if (health === "needs_attention") return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300"
  if (health === "partial") return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
  return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300"
}

export default function CodexPage() {
  const [repo, setRepo] = React.useState(DEFAULT_REPO)
  const [branch, setBranch] = React.useState("main")
  const [status, setStatus] = React.useState<GitHubCodexStatus | null>(null)
  const [context, setContext] = React.useState<GitHubCodexContext | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [statusLoading, setStatusLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setStatusLoading(true)
    githubCodexService.status()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((error) => {
        if (!cancelled) toast.error(error?.message || "No se pudo leer el estado de GitHub")
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const inspect = React.useCallback(async () => {
    const cleanRepo = repo.trim()
    if (!cleanRepo) {
      toast.error("Indica un repositorio GitHub")
      return
    }
    setLoading(true)
    try {
      const next = await githubCodexService.inspectRepository({
        repo: cleanRepo,
        branch: branch.trim() || undefined,
        limit: 10,
      })
      setContext(next)
      if (next.branch && !branch.trim()) setBranch(next.branch)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo inspeccionar el repositorio")
    } finally {
      setLoading(false)
    }
  }, [branch, repo])

  return (
    <main className="flex min-h-screen min-w-0 flex-col bg-background text-foreground">
      <header className="flex min-h-[60px] shrink-0 items-center gap-4 border-b border-border/60 bg-background/95 px-4 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
            <Code2 className="h-4 w-4 text-blue-600 dark:text-blue-300" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight tracking-normal">Codex</h1>
            <p className="truncate text-xs text-muted-foreground">GitHub context connector</p>
          </div>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "hidden h-7 gap-1.5 rounded-md px-2.5 font-medium sm:inline-flex",
              status?.configured
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300"
                : "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
            )}
          >
            {statusLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {status?.configured ? status.tokenSource : "Public read-only"}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={inspect}
            disabled={loading}
            className="h-8 rounded-md"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Inspeccionar
          </Button>
        </div>
      </header>

      <section className="border-b border-border/60 bg-muted/10 px-4 py-4 sm:px-6">
        <div className="mx-auto grid max-w-[1500px] gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Repositorio</span>
            <div className="relative">
              <Github className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repo"
                className="h-10 pl-9"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void inspect()
                }}
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
                placeholder="default"
                className="h-10 pl-9"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void inspect()
                }}
              />
            </div>
          </label>
          <div className="flex items-end">
            <Button type="button" onClick={inspect} disabled={loading} className="h-10 w-full md:w-auto">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              Analizar repo
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1500px] flex-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {context ? (
            <>
              <RepositoryOverview context={context} />
              <WorkflowsPanel context={context} />
              <ReadmePanel context={context} />
            </>
          ) : (
            <EmptyState status={status} loading={loading || statusLoading} />
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <SummaryPanel context={context} status={status} />
          <PullRequestsPanel context={context} />
          <IssuesPanel context={context} />
        </aside>
      </section>
    </main>
  )
}

function EmptyState({ status, loading }: { status: GitHubCodexStatus | null; loading: boolean }) {
  return (
    <div className="grid min-h-[420px] place-items-center rounded-lg border border-dashed border-border bg-muted/10 px-6 text-center">
      <div className="max-w-lg space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-background">
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : <Github className="h-5 w-5 text-muted-foreground" />}
        </div>
        <div>
          <h2 className="text-base font-semibold">Contexto de código listo para inspección</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {status?.configured
              ? "El token backend está configurado. Puedes analizar repos privados con los permisos de lectura adecuados."
              : "Sin token backend, el conector usa lectura pública con límites de GitHub."}
          </p>
        </div>
        <div className="mx-auto grid max-w-md grid-cols-1 gap-2 text-left text-xs text-muted-foreground sm:grid-cols-2">
          <span className="rounded-md border border-border bg-background px-3 py-2">README y branch</span>
          <span className="rounded-md border border-border bg-background px-3 py-2">PRs e issues</span>
          <span className="rounded-md border border-border bg-background px-3 py-2">GitHub Actions</span>
          <span className="rounded-md border border-border bg-background px-3 py-2">Resumen Codex</span>
        </div>
      </div>
    </div>
  )
}

function RepositoryOverview({ context }: { context: GitHubCodexContext }) {
  const repo = context.repository
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-normal">{repo.fullName}</h2>
            <Badge variant="outline" className="rounded-md">{repo.visibility}</Badge>
            {repo.archived ? <Badge variant="secondary" className="rounded-md">Archived</Badge> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{repo.description || "Sin descripción"}</p>
        </div>
        <Button variant="outline" size="sm" asChild className="ml-0 h-8 rounded-md sm:ml-auto">
          <a href={repo.htmlUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            Abrir GitHub
          </a>
        </Button>
      </div>

      <div className="grid gap-px bg-border/60 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Code2} label="Lenguaje" value={repo.language} />
        <Metric icon={GitBranch} label="Branch" value={context.branch || repo.defaultBranch} />
        <Metric icon={Star} label="Stars" value={String(repo.stargazersCount)} />
        <Metric icon={GitFork} label="Forks" value={String(repo.forksCount)} />
      </div>
    </section>
  )
}

function Metric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 bg-card p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/25">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold">{value}</div>
      </div>
    </div>
  )
}

function SummaryPanel({ context, status }: { context: GitHubCodexContext | null; status: GitHubCodexStatus | null }) {
  const health = context?.codexSummary.health
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-4">
        <CircleDot className="h-4 w-4 text-blue-600 dark:text-blue-300" />
        <h2 className="text-sm font-semibold">Resumen Codex</h2>
        <Badge variant="outline" className={cn("ml-auto rounded-md", healthClass(health))}>
          {healthLabel(health)}
        </Badge>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <div className="rounded-md border border-border bg-muted/15 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Modo GitHub</div>
          <div className="mt-1 font-semibold">
            {context?.auth.configured || status?.configured ? "Token backend" : "Lectura pública"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {context?.auth.tokenSource || status?.tokenSource || "Sin token privado configurado"}
          </div>
        </div>

        {context ? (
          <>
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Señales</div>
              <ul className="space-y-2">
                {context.codexSummary.signals.map((signal) => (
                  <li key={signal} className="flex gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{signal}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Siguiente acción</div>
              <ul className="space-y-2">
                {context.codexSummary.nextActions.map((action) => (
                  <li key={action} className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
                    {action}
                  </li>
                ))}
              </ul>
            </div>
            {context.warnings.length ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Contexto parcial
                </div>
                <ul className="mt-2 space-y-1">
                  {context.warnings.map((warning) => (
                    <li key={`${warning.area}-${warning.code}`}>{warning.area}: {warning.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            Ejecuta un análisis para preparar contexto de repositorio, PRs, issues, README y estado de CI.
          </p>
        )}
      </div>
    </section>
  )
}

function WorkflowsPanel({ context }: { context: GitHubCodexContext }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-4">
        <Activity className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold">GitHub Actions</h2>
      </div>
      <div className="divide-y divide-border/60">
        {context.workflowRuns.length ? context.workflowRuns.map((run) => (
          <a
            key={run.id}
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="grid gap-3 p-4 transition-colors hover:bg-muted/20 sm:grid-cols-[1fr_auto]"
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  run.conclusion === "success" ? "bg-emerald-500" : run.conclusion ? "bg-red-500" : "bg-amber-500",
                )} />
                <span className="truncate text-sm font-medium">{run.name}</span>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {run.displayTitle || run.event} · {run.branch || context.branch} · {run.headSha || "sin sha"}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="rounded-md">{run.conclusion || run.status || "unknown"}</Badge>
              <span>{formatDate(run.updatedAt)}</span>
            </div>
          </a>
        )) : (
          <div className="p-4 text-sm text-muted-foreground">No hay workflows recientes visibles.</div>
        )}
      </div>
    </section>
  )
}

function ReadmePanel({ context }: { context: GitHubCodexContext }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-4">
        <FileText className="h-4 w-4 text-indigo-600" />
        <h2 className="text-sm font-semibold">README</h2>
        {context.readme?.htmlUrl ? (
          <Button variant="ghost" size="sm" asChild className="ml-auto h-7 rounded-md px-2">
            <a href={context.readme.htmlUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
      {context.readme ? (
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap p-4 text-xs leading-5 text-muted-foreground">
          {context.readme.preview}
          {context.readme.truncated ? "\n\n[preview truncado]" : ""}
        </pre>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">README no visible en este branch.</div>
      )}
    </section>
  )
}

function PullRequestsPanel({ context }: { context: GitHubCodexContext | null }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-4">
        <GitPullRequest className="h-4 w-4 text-violet-600" />
        <h2 className="text-sm font-semibold">Pull requests</h2>
        <Badge variant="outline" className="ml-auto rounded-md">{context?.pullRequests.length ?? 0}</Badge>
      </div>
      <div className="divide-y divide-border/60">
        {context?.pullRequests.length ? context.pullRequests.map((pr) => (
          <a
            key={pr.number}
            href={pr.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="block p-4 transition-colors hover:bg-muted/20"
          >
            <div className="text-sm font-medium leading-5">#{pr.number} {pr.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {pr.author || "unknown"} · {pr.head} → {pr.base} · {formatDate(pr.updatedAt)}
            </div>
          </a>
        )) : (
          <div className="p-4 text-sm text-muted-foreground">Sin PRs abiertos en el rango.</div>
        )}
      </div>
    </section>
  )
}

function IssuesPanel({ context }: { context: GitHubCodexContext | null }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 p-4">
        <CircleDot className="h-4 w-4 text-orange-600" />
        <h2 className="text-sm font-semibold">Issues</h2>
        <Badge variant="outline" className="ml-auto rounded-md">{context?.issues.length ?? 0}</Badge>
      </div>
      <div className="divide-y divide-border/60">
        {context?.issues.length ? context.issues.map((issue) => (
          <a
            key={issue.number}
            href={issue.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="block p-4 transition-colors hover:bg-muted/20"
          >
            <div className="text-sm font-medium leading-5">#{issue.number} {issue.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{issue.author || "unknown"} · {formatDate(issue.updatedAt)}</span>
              {issue.labels.slice(0, 3).map((label) => (
                <Badge key={label} variant="secondary" className="rounded-md px-1.5 py-0 text-[10px]">
                  {label}
                </Badge>
              ))}
            </div>
          </a>
        )) : (
          <div className="p-4 text-sm text-muted-foreground">Sin issues abiertos en el rango.</div>
        )}
      </div>
    </section>
  )
}
