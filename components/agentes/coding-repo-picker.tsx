"use client"

/**
 * CodingRepoPicker — vincula un repositorio de GitHub (y una rama) al chat
 * actual de /agentes: el «Select repository» de Claude Code web, sobre los
 * contratos que ya existen. Lee repos/ramas con el OAuth del usuario
 * (GET /api/github/repos|search|:owner/:repo/branches) y clona con
 * POST /api/codex/projects/clone { chatId }, que deja el clon como proyecto
 * durable del chat (brief.chatId): desde ese momento las tools project_* del
 * agente y el editor trabajan sobre ese repo.
 *
 * Sin cuenta de GitHub conectada acepta la URL de un repo público (la rama se
 * escribe a mano). El componente nunca ve tokens: el backend los resuelve.
 */

import * as React from "react"
import { ExternalLink, FolderGit2, GitBranch, Lock, Search, X } from "lucide-react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import type { CodexCloneResult, CodexSourceControl } from "@/lib/codex/api/types"
import { githubService, type GithubBranch, type GithubRepo, type GithubStatus } from "@/lib/github-service"
import { cn } from "@/lib/utils"

export type CodingRepoPickerProps = {
  chatId: string
  /** sourceControl del proyecto ya vinculado: muestra el chip en vez del selector. */
  sourceControl?: CodexSourceControl | null
  disabled?: boolean
  onBound: (result: CodexCloneResult) => void | Promise<void>
  /** Inyectable para tests (window.location.assign no existe en jsdom). */
  navigate?: (url: string) => void
}

export type ParsedGithubRepo = {
  owner: string
  name: string
  fullName: string
  htmlUrl: string
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Acepta `https://github.com/owner/repo(.git)(/…)`, `github.com/owner/repo`
 * y el corto `owner/repo`. Devuelve null para cualquier otra cosa (texto de
 * búsqueda, hosts ajenos, rutas con traversal).
 */
export function parseGithubRepoInput(raw: string): ParsedGithubRepo | null {
  const value = String(raw || "").trim()
  if (!value || value.length > 300) return null
  let path = value
  const m = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i)
  if (m) path = m[1]
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes(".")) {
    // Otra URL (o algo con punto que no es owner/repo): no es un atajo.
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return null
  }
  const segs = path.split(/[?#]/)[0].split("/").filter(Boolean)
  if (segs.length < 2) return null
  const owner = segs[0]
  const name = segs[1].replace(/\.git$/i, "")
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..") return null
  return { owner, name, fullName: `${owner}/${name}`, htmlUrl: `https://github.com/${owner}/${name}` }
}

export function filterRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const q = String(query || "").trim().toLowerCase()
  if (!q) return repos
  return repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
}

function repoUrlFor(repo: Pick<GithubRepo, "fullName" | "htmlUrl">): string {
  return repo.htmlUrl || `https://github.com/${repo.fullName}`
}

function bindErrorMessage(err: unknown): string {
  const e = err as { status?: number; code?: string; body?: { error?: string; message?: string }; message?: string }
  const code = e?.body?.error || e?.code || ""
  if (e?.status === 409 && code === "chat_already_bound") {
    return "Este chat ya tiene un proyecto vinculado. Ábrelo desde «Mis proyectos…»."
  }
  if (e?.status === 404) return "El repositorio no existe o tu cuenta de GitHub no tiene acceso."
  if (e?.status === 401 || code === "github_auth_required") return "Conecta GitHub para clonar repositorios privados."
  return e?.body?.message || e?.message || "No se pudo vincular el repositorio."
}

export function CodingRepoPicker({
  chatId,
  sourceControl = null,
  disabled = false,
  onBound,
  navigate,
}: CodingRepoPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<GithubStatus | null>(null)
  const [statusLoading, setStatusLoading] = React.useState(false)
  const [repos, setRepos] = React.useState<GithubRepo[]>([])
  const [reposLoading, setReposLoading] = React.useState(false)
  const [searchHits, setSearchHits] = React.useState<GithubRepo[]>([])
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<GithubRepo | null>(null)
  const [branches, setBranches] = React.useState<GithubBranch[]>([])
  const [branchesLoading, setBranchesLoading] = React.useState(false)
  const [branchesFailed, setBranchesFailed] = React.useState(false)
  const [branch, setBranch] = React.useState("")
  const [cloning, setCloning] = React.useState(false)
  const [error, setError] = React.useState("")
  const loadedRef = React.useRef(false)
  const connected = Boolean(status?.connected)

  const goTo = React.useCallback(
    (url: string) => {
      if (navigate) navigate(url)
      else if (typeof window !== "undefined") window.location.assign(url)
    },
    [navigate],
  )

  // Estado de GitHub + repos del usuario: una sola carga al abrir por primera vez.
  React.useEffect(() => {
    if (!open || loadedRef.current) return
    loadedRef.current = true
    let cancelled = false
    void (async () => {
      setStatusLoading(true)
      try {
        const st = await githubService.status()
        if (cancelled) return
        setStatus(st)
        if (st.connected) {
          setReposLoading(true)
          try {
            const page = await githubService.listRepos({ perPage: 100, sort: "updated" })
            if (!cancelled) setRepos(page.repos)
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : "No se pudieron cargar tus repositorios.")
          } finally {
            if (!cancelled) setReposLoading(false)
          }
        }
      } catch {
        if (!cancelled) setStatus({ connected: false, configured: true } as GithubStatus)
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Búsqueda remota solo cuando el filtro local no encuentra nada (repos de
  // organizaciones grandes fuera de la primera página).
  const localHits = React.useMemo(() => filterRepos(repos, query), [repos, query])
  React.useEffect(() => {
    const q = query.trim()
    if (!connected || q.length < 2 || localHits.length > 0 || parseGithubRepoInput(q)) {
      setSearchHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void githubService
        .searchRepos(q, { perPage: 20 })
        .then((res) => {
          if (!cancelled) setSearchHits(res.items)
        })
        .catch(() => {
          if (!cancelled) setSearchHits([])
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, connected, localHits.length])

  const manual = React.useMemo(() => {
    const parsed = parseGithubRepoInput(query)
    if (!parsed) return null
    const known = [...repos, ...searchHits].find((r) => r.fullName.toLowerCase() === parsed.fullName.toLowerCase())
    return known ? null : parsed
  }, [query, repos, searchHits])

  const visible = React.useMemo(() => {
    const merged = localHits.length > 0 ? localHits : searchHits
    return merged.slice(0, 30)
  }, [localHits, searchHits])

  async function selectRepo(repo: GithubRepo) {
    setSelected(repo)
    setError("")
    setBranches([])
    setBranchesFailed(false)
    setBranch(repo.defaultBranch || "main")
    if (!connected) {
      setBranchesFailed(true)
      return
    }
    setBranchesLoading(true)
    try {
      const out = await githubService.listBranches(repo.owner, repo.name)
      setBranches(out.branches)
      setBranch(out.defaultBranch || repo.defaultBranch || "main")
    } catch {
      setBranchesFailed(true)
    } finally {
      setBranchesLoading(false)
    }
  }

  function selectManual(parsed: ParsedGithubRepo) {
    void selectRepo({
      repoId: "",
      fullName: parsed.fullName,
      owner: parsed.owner,
      name: parsed.name,
      private: false,
      defaultBranch: "main",
      cloneUrl: `${parsed.htmlUrl}.git`,
      htmlUrl: parsed.htmlUrl,
    })
  }

  async function handleConnect() {
    setError("")
    try {
      const { url } = await githubService.connectUrl()
      if (!url) throw new Error("No se pudo iniciar la conexión con GitHub.")
      goTo(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la conexión con GitHub.")
    }
  }

  async function handleBind() {
    if (!selected || !branch.trim() || cloning || !chatId) return
    setCloning(true)
    setError("")
    try {
      const result = await projectsCodexApi.cloneRepository({
        name: selected.name,
        repoUrl: repoUrlFor(selected),
        branch: branch.trim(),
        chatId,
      })
      await onBound(result)
      setOpen(false)
    } catch (err) {
      setError(bindErrorMessage(err))
    } finally {
      setCloning(false)
    }
  }

  if (sourceControl) {
    const label = sourceControl.fullName || sourceControl.repository || "repositorio"
    const inner = (
      <>
        <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="max-w-44 truncate" data-testid="agentes-coding-repo-chip-name">
          {label}
        </span>
        {sourceControl.private ? <Lock className="h-3 w-3 shrink-0 opacity-70" aria-label="Privado" /> : null}
        {sourceControl.sourceBranch ? (
          <>
            <GitBranch className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
            <span className="max-w-32 truncate" data-testid="agentes-coding-repo-chip-branch">
              {sourceControl.sourceBranch}
            </span>
          </>
        ) : null}
      </>
    )
    const chipClass =
      "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 text-xs"
    return sourceControl.webUrl ? (
      <a
        href={sourceControl.webUrl}
        target="_blank"
        rel="noreferrer"
        className={cn(chipClass, "hover:bg-muted")}
        title={`Abrir ${label} en GitHub`}
        data-testid="agentes-coding-repo-chip"
      >
        {inner}
        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </a>
    ) : (
      <span className={chipClass} data-testid="agentes-coding-repo-chip">
        {inner}
      </span>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={chatId ? "Vincular un repositorio de GitHub a este chat" : "Abre un chat para vincular un repositorio"}
        data-testid="agentes-coding-repo-trigger"
      >
        <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
        Vincular repositorio
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Vincular repositorio"
          className="absolute left-0 top-9 z-30 flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 rounded-md border border-border bg-background p-3 text-xs shadow-lg"
          data-testid="agentes-coding-repo-panel"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Repositorio de GitHub</p>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              onClick={() => setOpen(false)}
              aria-label="Cerrar"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {statusLoading ? (
            <ThinkingIndicator size="xs" label="Consultando GitHub" />
          ) : status && !status.configured ? (
            <p className="text-muted-foreground" data-testid="agentes-coding-repo-unconfigured">
              GitHub no está configurado en el servidor. Puedes pegar la URL de un repositorio público.
            </p>
          ) : status && !status.connected ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="agentes-coding-repo-disconnected">
              <p className="text-muted-foreground">Conecta tu cuenta para ver tus repositorios privados.</p>
              <button
                type="button"
                className="h-7 rounded-md border border-border px-2"
                onClick={handleConnect}
                data-testid="agentes-coding-repo-connect"
              >
                Conectar GitHub
              </button>
            </div>
          ) : status?.connected ? (
            <p className="text-muted-foreground">
              Conectado como <span className="font-medium text-foreground">{status.login}</span>
            </p>
          ) : null}

          <label className="relative block">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <input
              className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={connected ? "Buscar repositorio o pegar URL…" : "URL del repositorio público, p. ej. github.com/owner/repo"}
              aria-label="Buscar repositorio"
              autoFocus
              data-testid="agentes-coding-repo-search"
            />
          </label>

          <ul className="max-h-48 overflow-auto rounded-md border border-border" data-testid="agentes-coding-repo-list">
            {manual ? (
              <li>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted",
                    selected?.fullName === manual.fullName && "bg-muted",
                  )}
                  onClick={() => selectManual(manual)}
                  aria-pressed={selected?.fullName === manual.fullName}
                  data-testid="agentes-coding-repo-manual"
                >
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">Usar {manual.fullName}</span>
                </button>
              </li>
            ) : null}
            {visible.map((repo) => (
              <li key={repo.repoId || repo.fullName}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted",
                    selected?.fullName === repo.fullName && "bg-muted",
                  )}
                  onClick={() => void selectRepo(repo)}
                  aria-pressed={selected?.fullName === repo.fullName}
                  data-testid="agentes-coding-repo-option"
                >
                  {repo.private ? (
                    <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" aria-label="Privado" />
                  ) : (
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                  <span className="shrink-0 text-muted-foreground">{repo.defaultBranch}</span>
                </button>
              </li>
            ))}
            {reposLoading ? (
              <li className="px-2 py-1.5">
                <ThinkingIndicator size="xs" label="Cargando repositorios" />
              </li>
            ) : !manual && visible.length === 0 ? (
              <li className="px-2 py-1.5 text-muted-foreground" data-testid="agentes-coding-repo-empty">
                {connected ? "Sin resultados." : "Pega la URL de un repositorio público de GitHub."}
              </li>
            ) : null}
          </ul>

          {selected ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="agentes-coding-repo-branch-row">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">Rama</span>
              {branchesLoading ? (
                <ThinkingIndicator size="xs" label="Cargando ramas" />
              ) : branches.length > 0 && !branchesFailed ? (
                <select
                  className="h-7 min-w-0 max-w-60 truncate rounded-md border border-border bg-background px-1"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  aria-label="Rama"
                  data-testid="agentes-coding-repo-branch"
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="h-7 w-40 rounded-md border border-border bg-background px-2"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  aria-label="Rama"
                  data-testid="agentes-coding-repo-branch-input"
                />
              )}
            </div>
          ) : null}

          {error ? (
            <p className="text-destructive" role="alert" data-testid="agentes-coding-repo-error">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {cloning ? <ThinkingIndicator size="xs" label="Clonando" /> : null}
            <button
              type="button"
              className="h-8 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50"
              onClick={handleBind}
              disabled={!selected || !branch.trim() || cloning || !chatId}
              data-testid="agentes-coding-repo-bind"
            >
              Abrir en este chat
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default CodingRepoPicker
