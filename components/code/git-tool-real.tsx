"use client"

/**
 * RealGitPanel — the live GitHub version-control panel embedded in the /code
 * workspace "Git" tool. Replit-style:
 *
 *   not connected           → GitHub OAuth sign-in card
 *   connected, no repo bound → pick a connected repo or import one
 *   bound + cloned          → full GitPane (status / stage / commit / push /
 *                             pull / branches / history) for that repo
 *
 * The (project → connected-repo) binding is persisted per project in
 * localStorage so each /code workspace remembers which GitHub repo it syncs.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Download,
  Loader2,
  Lock,
  FolderGit2,
  RefreshCw,
  ExternalLink,
  Unlink,
  FolderInput,
  UploadCloud,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { GithubConnectCard } from "@/components/workspace/github-connect-card"
import { GitPane } from "@/components/workspace/git-pane"
import {
  githubService,
  type GithubRepo,
  type ConnectedRepository,
} from "@/lib/github-service"

function bindKey(projectId: string | null) {
  return `siragpt:code-git-connection:${projectId || "default"}`
}
function readBinding(projectId: string | null): string | null {
  try {
    return window.localStorage.getItem(bindKey(projectId))
  } catch {
    return null
  }
}
function writeBinding(projectId: string | null, connectionId: string | null) {
  try {
    if (connectionId) window.localStorage.setItem(bindKey(projectId), connectionId)
    else window.localStorage.removeItem(bindKey(projectId))
  } catch {
    /* quota / private mode — non-fatal */
  }
}

export function RealGitPanel({ projectId }: { projectId: string | null; projectName?: string }) {
  const router = useRouter()
  const { hydrateFiles, files } = useCodeWorkspace()
  const [connected, setConnected] = React.useState<boolean | null>(null) // null = loading
  const [boundId, setBoundId] = React.useState<string | null>(null)
  const [bound, setBound] = React.useState<ConnectedRepository | null>(null)
  const [loadingRepo, setLoadingRepo] = React.useState(false)
  const [pushingFiles, setPushingFiles] = React.useState(false)

  // Push every current /code workspace file into the bound clone (editor → repo).
  // Use this once to publish what you already built; ongoing edits mirror live.
  const uploadWorkspaceToRepo = React.useCallback(async () => {
    if (!boundId) return
    const entries = Object.values(files)
    if (entries.length === 0) {
      toast.error("El workspace está vacío")
      return
    }
    setPushingFiles(true)
    try {
      let ok = 0
      for (const f of entries) {
        try {
          await githubService.writeFile(boundId, f.path, f.content)
          ok += 1
        } catch {
          /* skip the file that failed, keep going */
        }
      }
      toast.success(`Subidos ${ok}/${entries.length} archivos al repo. Ahora haz Commit + Push.`)
    } finally {
      setPushingFiles(false)
    }
  }, [boundId, files])

  const loadRepoIntoEditor = React.useCallback(async () => {
    if (!boundId) return
    setLoadingRepo(true)
    try {
      const { files, truncated } = await githubService.filesWithContent(boundId)
      hydrateFiles(files)
      toast.success(`Cargados ${files.length} archivos del repo${truncated ? " (truncado)" : ""}`)
    } catch (e) {
      toast.error((e as Error).message || "No se pudieron cargar los archivos")
    } finally {
      setLoadingRepo(false)
    }
  }, [boundId, hydrateFiles])

  // 1. Resolve any saved binding for this project + initial connection status.
  React.useEffect(() => {
    setBoundId(readBinding(projectId))
  }, [projectId])

  React.useEffect(() => {
    let alive = true
    githubService
      .status()
      .then((s) => alive && setConnected(Boolean(s.connected)))
      .catch(() => alive && setConnected(false))
    return () => {
      alive = false
    }
  }, [])

  // 2. Once we know we're connected, hydrate the bound repo (and verify clone).
  const hydrateBound = React.useCallback(async () => {
    if (!boundId) {
      setBound(null)
      return
    }
    try {
      const { connections } = await githubService.listConnected()
      const match = connections.find((c) => c.id === boundId) || null
      setBound(match)
      if (!match) {
        // binding stale — clear it
        writeBinding(projectId, null)
        setBoundId(null)
      }
    } catch {
      setBound(null)
    }
  }, [boundId, projectId])

  React.useEffect(() => {
    if (connected) void hydrateBound()
  }, [connected, hydrateBound])

  const bind = (id: string) => {
    writeBinding(projectId, id)
    setBoundId(id)
  }
  const unbind = () => {
    writeBinding(projectId, null)
    setBoundId(null)
    setBound(null)
  }

  // ── Render ───────────────────────────────────────────────────
  if (connected === null) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  // Not connected → OAuth card (and keep listening for status).
  if (!connected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Conecta tu cuenta de GitHub para activar el control de versiones (commit, push, pull, ramas).
        </p>
        <GithubConnectCard onChange={(s) => setConnected(Boolean(s.connected))} />
      </div>
    )
  }

  // Connected but no repo chosen for this project → picker.
  if (!boundId || !bound) {
    return (
      <div className="space-y-4">
        {/* keep the connect card visible (shows account + lets disconnect) */}
        <GithubConnectCard onChange={(s) => setConnected(Boolean(s.connected))} />
        <RepoBinder projectId={projectId} onBound={bind} />
      </div>
    )
  }

  const ready = bound.workspace?.status === "ready"

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{bound.fullName}</span>
          {bound.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {bound.htmlUrl && (
            <a href={bound.htmlUrl} target="_blank" rel="noreferrer" className="text-muted-foreground">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            title="Descargar todo el código (.zip)"
            onClick={() => {
              toast.info("Preparando descarga…")
              githubService
                .downloadZip(bound.id, `${bound.name}.zip`)
                .catch((e) => toast.error((e as Error).message || "Descarga fallida"))
            }}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            Descargar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loadingRepo}
            title="Cargar los archivos del repo en el editor de /code (repo → editor)"
            onClick={loadRepoIntoEditor}
          >
            {loadingRepo ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderInput className="mr-1 h-3.5 w-3.5" />
            )}
            Cargar del repo
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pushingFiles}
            title="Subir los archivos actuales del editor al repo (editor → repo)"
            onClick={uploadWorkspaceToRepo}
          >
            {pushingFiles ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <UploadCloud className="mr-1 h-3.5 w-3.5" />
            )}
            Subir al repo
          </Button>
          <Button size="sm" variant="outline" onClick={() => router.push(`/workspace/${bound.id}`)}>
            Abrir editor completo
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={unbind} title="Cambiar repositorio">
            <Unlink className="mr-1 h-3.5 w-3.5" />
            Cambiar
          </Button>
        </div>
      </div>

      {ready ? (
        <div className="h-[60vh] overflow-hidden rounded-lg border border-border">
          <GitPane id={bound.id} repoFullName={bound.fullName} repoUrl={bound.htmlUrl} />
        </div>
      ) : (
        <CloneGate connection={bound} onCloned={hydrateBound} />
      )}
    </div>
  )
}

/** Connected-repo list + GitHub search to bind a repo to this project. */
function RepoBinder({ projectId, onBound }: { projectId: string | null; onBound: (id: string) => void }) {
  const [connections, setConnections] = React.useState<ConnectedRepository[]>([])
  const [repos, setRepos] = React.useState<GithubRepo[]>([])
  const [query, setQuery] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const loadConnected = React.useCallback(async () => {
    try {
      const { connections: list } = await githubService.listConnected()
      setConnections(list)
    } catch {
      /* ignore */
    }
  }, [])
  const loadRepos = React.useCallback(async () => {
    setLoading(true)
    try {
      const { repos: list } = await githubService.listRepos({ perPage: 50, sort: "updated" })
      setRepos(list)
    } catch (e) {
      toast.error((e as Error).message || "No se pudieron cargar tus repos")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadConnected()
    void loadRepos()
  }, [loadConnected, loadRepos])

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return loadRepos()
    setLoading(true)
    try {
      const { items } = await githubService.searchRepos(query.trim(), { perPage: 30 })
      setRepos(items)
    } catch (e) {
      toast.error((e as Error).message || "Búsqueda fallida")
    } finally {
      setLoading(false)
    }
  }

  // Connect (if needed) + clone + bind.
  const pickRepo = async (repo: GithubRepo) => {
    setBusyId(repo.repoId)
    try {
      const existing = connections.find((c) => c.repoId === repo.repoId)
      const connection = existing || (await githubService.connectRepo(repo.owner, repo.name)).connection
      toast.info("Clonando repositorio…")
      await githubService.clone(connection.id)
      onBound(connection.id)
      toast.success("Repositorio vinculado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo vincular el repositorio")
    } finally {
      setBusyId(null)
    }
  }

  const pickConnected = async (c: ConnectedRepository) => {
    setBusyId(c.id)
    try {
      if (c.workspace?.status !== "ready") {
        toast.info("Clonando…")
        await githubService.clone(c.id)
      }
      onBound(c.id)
      toast.success("Repositorio vinculado")
    } catch (e) {
      toast.error((e as Error).message || "Clonación fallida")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      {connections.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Repos conectados
          </h3>
          <div className="grid gap-1.5">
            {connections.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <span className="truncate">{c.fullName}</span>
                <Button size="sm" disabled={busyId === c.id} onClick={() => pickConnected(c)}>
                  {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Usar"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Importar desde GitHub
        </h3>
        <form onSubmit={search} className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar repos… (vacío = recientes)"
              className="h-9 pl-9 text-sm"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" className="h-9" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Buscar"}
          </Button>
        </form>
        <div className="grid max-h-72 gap-1.5 overflow-y-auto pr-1">
          {repos.map((r) => (
            <div
              key={r.repoId}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 truncate">
                  <span className="truncate">{r.fullName}</span>
                  {r.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                </div>
                {r.language && <span className="text-xs text-muted-foreground">{r.language}</span>}
              </div>
              <Button size="sm" disabled={busyId === r.repoId} onClick={() => pickRepo(r)}>
                {busyId === r.repoId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                Usar
              </Button>
            </div>
          ))}
          {repos.length === 0 && !loading && <p className="text-xs text-muted-foreground">Sin resultados.</p>}
        </div>
      </div>
    </div>
  )
}

/** Shown when a repo is bound but not yet cloned on the server. */
function CloneGate({ connection, onCloned }: { connection: ConnectedRepository; onCloned: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const clone = async () => {
    setBusy(true)
    try {
      await githubService.clone(connection.id)
      toast.success("Clonado")
      onCloned()
    } catch (e) {
      toast.error((e as Error).message || "Clonación fallida")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
      <p className="text-sm text-muted-foreground">El repositorio aún no está clonado en el servidor.</p>
      <Button size="sm" disabled={busy} onClick={clone}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
        Clonar ahora
      </Button>
    </div>
  )
}
