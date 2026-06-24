"use client"

/**
 * GitPane — version-control panel styled to match Replit's Git pane:
 *   - branch bar (branch selector + refresh)
 *   - Remote Updates: repo chip, origin/<branch> • upstream, last fetched,
 *     "Can't pull: you have uncommitted changes" warning, Sync/Pull/Push
 *   - Commit: message (Ctrl ⏎), Review Changes, changed files (M/A/D/U badge +
 *     stage/revert), "Stage and commit all changes"
 *   - History: "Not pulled / Not pushed / Up to date with remote" divider +
 *     commit list
 */

import * as React from "react"
import {
  GitBranch,
  Github,
  ArrowUp,
  ArrowDown,
  Loader2,
  RefreshCw,
  Plus,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ExternalLink,
  User,
  FileCode2,
  Check,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  githubService,
  type GitStatus,
  type GitBranches,
  type GitCommit,
  type WorkspaceState,
} from "@/lib/github-service"

interface Props {
  id: string
  repoFullName?: string
  repoUrl?: string | null
  onAfterCommit?: () => void
  /** When true, the pane grows to its content height (the outer page scrolls)
   *  instead of filling a fixed-height container with an inner scrollbar. */
  fitContent?: boolean
}

function statusBadge(index: string, workingDir: string): { letter: string; cls: string } {
  const code = (workingDir !== " " && workingDir !== "" ? workingDir : index) || "?"
  switch (code) {
    case "M":
      return { letter: "M", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" }
    case "A":
      return { letter: "A", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" }
    case "D":
      return { letter: "D", cls: "bg-red-500/15 text-red-600 dark:text-red-400" }
    case "?":
      return { letter: "U", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" }
    case "R":
      return { letter: "R", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" }
    default:
      return { letter: code, cls: "bg-muted text-muted-foreground" }
  }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "nunca"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "nunca"
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return "hace un momento"
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.floor(h / 24)
  return `hace ${d} día${d > 1 ? "s" : ""}`
}

export function GitPane({ id, repoFullName, repoUrl, onAfterCommit, fitContent }: Props) {
  const [status, setStatus] = React.useState<GitStatus | null>(null)
  const [branches, setBranches] = React.useState<GitBranches | null>(null)
  const [commits, setCommits] = React.useState<GitCommit[]>([])
  const [workspace, setWorkspace] = React.useState<WorkspaceState | null>(null)
  const [message, setMessage] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = React.useState(true)
  const [filesOpen, setFilesOpen] = React.useState(true)

  const refresh = React.useCallback(async () => {
    try {
      const [{ status: s }, { branches: b }, { commits: c }, { workspace: w }] = await Promise.all([
        githubService.gitStatus(id),
        githubService.branches(id),
        githubService.commits(id, 20),
        githubService.workspace(id),
      ])
      setStatus(s)
      setBranches(b)
      setCommits(c)
      setWorkspace(w)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo leer el estado git")
    } finally {
      setLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key)
    try {
      await fn()
      if (okMsg) toast.success(okMsg)
      await refresh()
    } catch (e) {
      toast.error((e as Error).message || "Operación fallida")
    } finally {
      setBusy(null)
    }
  }

  const files = status?.files || []
  const dirty = files.length > 0
  const ahead = status?.ahead || 0
  const behind = status?.behind || 0
  const current = status?.current || branches?.current || "main"
  const upstream = status?.tracking || `origin/${current}`

  const localBranches = branches?.local || []
  const remoteOnly = (branches?.remote || [])
    .map((r) => r.replace(/^origin\//, ""))
    .filter((b) => b && b !== "HEAD" && !localBranches.includes(b))

  const switchBranch = (name: string) =>
    run(`switch:${name}`, () => githubService.switchBranch(id, name), `Cambiado a ${name}`)

  const sync = () =>
    run(
      "sync",
      async () => {
        await githubService.fetch(id, current)
        if (behind > 0 && !dirty) await githubService.pull(id, current)
        if (ahead > 0) await githubService.push(id, { branch: current, setUpstream: !status?.tracking })
      },
      "Sincronizado con el remoto",
    )
  const pull = () => run("pull", () => githubService.pull(id, current), "Pull completado")
  const push = () =>
    run("push", () => githubService.push(id, { branch: current, setUpstream: !status?.tracking }), "Push completado")

  const stageAll = () => run("stageAll", () => githubService.stage(id, ["."]), "Todo preparado")
  const stageOne = (path: string) => run(`stage:${path}`, () => githubService.stage(id, [path]))
  const discardAll = () => {
    if (!confirm("¿Descartar TODOS los cambios sin confirmar? Esto no se puede deshacer.")) return
    void run("discard", () => githubService.discard(id), "Cambios descartados")
  }
  const discardOne = (path: string) => {
    if (!confirm(`¿Descartar los cambios de ${path}?`)) return
    void run(`discard:${path}`, () => githubService.discard(id, [path]))
  }

  const commitAll = async () => {
    if (!message.trim()) return toast.error("Escribe un mensaje de commit")
    setBusy("commit")
    try {
      await githubService.stage(id, ["."])
      const res = await githubService.commit(id, message.trim())
      toast.success(`Commit ${res.commit?.slice(0, 7) || ""} creado`)
      setMessage("")
      await refresh()
      onAfterCommit?.()
    } catch (e) {
      toast.error((e as Error).message || "Commit fallido")
    } finally {
      setBusy(null)
    }
  }

  const createBranch = async () => {
    const name = prompt("Nombre de la nueva rama:")?.trim()
    if (!name) return
    await run("createBranch", () => githubService.createBranch(id, name), `Rama ${name} creada`)
  }

  const dividerLabel =
    behind > 0 ? "No traído del remoto" : ahead > 0 ? "No enviado al remoto" : "Al día con el remoto"

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  const syncCount = behind || ahead

  return (
    <div className={cn("flex flex-col bg-background text-sm", !fitContent && "h-full min-h-0")}>
      {/* Branch bar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="relative inline-flex items-center">
          <select
            value={current}
            onChange={(e) => switchBranch(e.target.value)}
            className="max-w-[180px] cursor-pointer truncate rounded bg-transparent pr-5 text-sm font-medium outline-none"
          >
            {localBranches.length > 0 && (
              <optgroup label="Locales">
                {localBranches.map((b) => (
                  <option key={`l-${b}`} value={b}>
                    {b}
                  </option>
                ))}
              </optgroup>
            )}
            {remoteOnly.length > 0 && (
              <optgroup label="Remotas (origin)">
                {remoteOnly.map((b) => (
                  <option key={`r-${b}`} value={b}>
                    {b}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <ChevronDown className="pointer-events-none absolute right-0 h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          onClick={createBranch}
          title="Nueva rama"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            busy && "opacity-60",
          )}
          onClick={refresh}
          title="Refrescar"
        >
          <RefreshCw className={cn("h-4 w-4", busy === "refresh" && "animate-spin")} />
        </button>
      </div>

      <div className={cn("space-y-6 px-4 py-4", !fitContent && "min-h-0 flex-1 overflow-y-auto")}>
        {/* ── Remote Updates ───────────────────────────── */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">Remote Updates</h3>
            {repoFullName && (
              <a
                href={repoUrl || `https://github.com/${repoFullName}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Github className="h-3.5 w-3.5" />
                {repoFullName}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{upstream}</span> • upstream
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                actualizado {relTime(workspace?.lastSyncAt)}
                <button
                  className="rounded p-0.5 hover:text-foreground"
                  onClick={() => run("fetch", () => githubService.fetch(id, current), "Fetch completado")}
                  title="Fetch"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", busy === "fetch" && "animate-spin")} />
                </button>
              </span>
            </div>

            {dirty && behind > 0 && (
              <div className="flex items-center gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                No se puede hacer pull: tienes cambios sin confirmar
              </div>
            )}

            <div className="flex items-stretch border-t border-border/70">
              <button
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed",
                  syncCount > 0
                    ? "bg-foreground text-background hover:opacity-90"
                    : "bg-muted/60 text-muted-foreground",
                )}
                disabled={busy === "sync" || (ahead === 0 && behind === 0)}
                onClick={sync}
              >
                {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync Changes
                {syncCount > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    {syncCount}
                    {behind > 0 ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
                  </span>
                )}
              </button>
              <button
                className="flex items-center gap-1 border-l border-border px-3 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy === "pull" || dirty || behind === 0}
                onClick={pull}
                title="Pull"
              >
                {busy === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDown className="h-3.5 w-3.5" />}
                Pull
              </button>
              <button
                className="flex items-center gap-1 border-l border-border px-3 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy === "push" || ahead === 0}
                onClick={push}
                title="Push"
              >
                {busy === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                Push
              </button>
            </div>
          </div>
        </section>

        {/* ── Commit ───────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-[15px] font-semibold">Commit</h3>
          {!dirty ? (
            <p className="text-sm text-muted-foreground">No hay cambios para confirmar.</p>
          ) : (
          <>
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            Message
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl ⏎</kbd>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault()
                void commitAll()
              }
            }}
            placeholder="Summary"
            rows={2}
            className="mb-3 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-sky-500"
          />

          {/* Review Changes */}
          <div className="rounded-lg border border-border">
            <button
              className="flex w-full items-center justify-between px-3 py-2"
              onClick={() => setReviewOpen((o) => !o)}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {reviewOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Review Changes
                <span className="text-xs font-normal text-muted-foreground">
                  {files.length} {files.length === 1 ? "change" : "changes"}
                </span>
              </span>
              {files.length > 0 && (
                <span className="flex items-center gap-2 text-xs">
                  <button
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-red-500"
                    onClick={(e) => {
                      e.stopPropagation()
                      discardAll()
                    }}
                  >
                    <RotateCcw className="h-3 w-3" /> Discard All
                  </button>
                  <span className="text-border">|</span>
                  <button
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      stageAll()
                    }}
                  >
                    <Plus className="h-3 w-3" /> Stage All
                  </button>
                </span>
              )}
            </button>

            {reviewOpen && (
              <div className="border-t border-border">
                {files.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No hay cambios. Tu árbol está limpio. ✨
                  </p>
                ) : (
                  <>
                    <button
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground"
                      onClick={() => setFilesOpen((o) => !o)}
                    >
                      {filesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {files.length} changed {files.length === 1 ? "file" : "files"}
                    </button>
                    {filesOpen &&
                      files.map((f) => {
                        const { letter, cls } = statusBadge(f.index, f.workingDir)
                        const staged = f.index !== " " && f.index !== "?" && f.index !== ""
                        return (
                          <div
                            key={f.path}
                            className="group flex items-center gap-2 px-3 py-1.5 hover:bg-foreground/5"
                          >
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                              {f.path}
                            </span>
                            <button
                              className="hidden rounded p-0.5 text-muted-foreground hover:text-red-500 group-hover:block"
                              title="Descartar cambios"
                              onClick={() => discardOne(f.path)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                            {staged ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <button
                                className="hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                                title="Preparar"
                                onClick={() => stageOne(f.path)}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <span className={cn("flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold", cls)}>
                              {letter}
                            </span>
                          </div>
                        )
                      })}
                  </>
                )}
              </div>
            )}
          </div>

          <p className="my-2 text-center text-xs text-muted-foreground">
            Confirmar preparará tus cambios automáticamente.
          </p>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 py-2.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy === "commit" || files.length === 0 || !message.trim()}
            onClick={commitAll}
          >
            {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Stage and commit all changes
          </button>
          </>
          )}
        </section>

        {/* ── History ──────────────────────────────────── */}
        <section>
          <div className="mb-3 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {behind > 0 ? (
                <ArrowDown className="h-3 w-3" />
              ) : ahead > 0 ? (
                <ArrowUp className="h-3 w-3" />
              ) : null}
              {dividerLabel}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-3">
            {commits.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground">Sin commits todavía.</p>
            ) : (
              commits.map((c) => (
                <div key={c.hash} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.message}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      {c.authorName} · {relTime(c.date)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
