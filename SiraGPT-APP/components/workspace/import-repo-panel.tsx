"use client"

/**
 * ImportRepoPanel — "Import code or design" Replit-style.
 *
 * Two sections:
 *   1. Your workspaces  — already-connected repos (open / clone / remove)
 *   2. Import from GitHub — search/list your GitHub repos, then
 *      "Connect & clone" → server clones the repo → open the workspace.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Lock,
  GitBranch,
  Loader2,
  Download,
  FolderGit2,
  Trash2,
  Star,
  RefreshCw,
  ExternalLink,
  Plus,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  githubService,
  type GithubRepo,
  type ConnectedRepository,
} from "@/lib/github-service"

function statusBadge(status?: string | null) {
  switch (status) {
    case "ready":
      return <span className="text-xs text-emerald-500">listo</span>
    case "cloning":
      return <span className="text-xs text-sky-500">clonando…</span>
    case "error":
      return <span className="text-xs text-red-500">error</span>
    default:
      return <span className="text-xs text-muted-foreground">sin clonar</span>
  }
}

export function ImportRepoPanel({ connected: connectedEnabled }: { connected: boolean }) {
  const router = useRouter()
  const [connections, setConnections] = React.useState<ConnectedRepository[]>([])
  const [repos, setRepos] = React.useState<GithubRepo[]>([])
  const [query, setQuery] = React.useState("")
  const [loadingRepos, setLoadingRepos] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const loadConnections = React.useCallback(async () => {
    try {
      const { connections: list } = await githubService.listConnected()
      setConnections(list)
    } catch {
      /* not connected yet — ignore */
    }
  }, [])

  const loadRepos = React.useCallback(async () => {
    setLoadingRepos(true)
    try {
      const { repos: list } = await githubService.listRepos({ perPage: 50, sort: "updated" })
      setRepos(list)
    } catch (e) {
      toast.error((e as Error).message || "No se pudieron cargar tus repos")
    } finally {
      setLoadingRepos(false)
    }
  }, [])

  React.useEffect(() => {
    if (connectedEnabled) {
      void loadConnections()
      void loadRepos()
    }
  }, [connectedEnabled, loadConnections, loadRepos])

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return loadRepos()
    setLoadingRepos(true)
    try {
      const { items } = await githubService.searchRepos(query.trim(), { perPage: 30 })
      setRepos(items)
    } catch (e) {
      toast.error((e as Error).message || "Búsqueda fallida")
    } finally {
      setLoadingRepos(false)
    }
  }

  // Connect (persist) + clone, then open the workspace.
  const importRepo = async (repo: GithubRepo) => {
    setBusyId(repo.repoId)
    try {
      toast.info(`Conectando ${repo.fullName}…`)
      const { connection } = await githubService.connectRepo(repo.owner, repo.name)
      toast.info("Clonando repositorio…")
      await githubService.clone(connection.id)
      toast.success("¡Listo! Abriendo workspace…")
      router.push(`/workspace/${connection.id}`)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo importar el repositorio")
    } finally {
      setBusyId(null)
    }
  }

  // Phase F — create a brand-new GitHub repo, clone, open.
  const [newName, setNewName] = React.useState("")
  const [newPrivate, setNewPrivate] = React.useState(true)
  const [creating, setCreating] = React.useState(false)
  const createRepo = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      toast.info(`Creando ${name} en GitHub…`)
      const { connection } = await githubService.createRepo({ name, private: newPrivate })
      await githubService.clone(connection.id)
      toast.success("Repositorio creado y clonado")
      router.push(`/workspace/${connection.id}`)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo crear el repositorio")
    } finally {
      setCreating(false)
    }
  }

  const cloneExisting = async (c: ConnectedRepository) => {
    setBusyId(c.id)
    try {
      toast.info("Clonando…")
      await githubService.clone(c.id)
      toast.success("Clonado")
      router.push(`/workspace/${c.id}`)
    } catch (e) {
      toast.error((e as Error).message || "Clonación fallida")
    } finally {
      setBusyId(null)
    }
  }

  const removeConnection = async (c: ConnectedRepository) => {
    if (!confirm(`¿Quitar ${c.fullName} de tus workspaces?`)) return
    setBusyId(c.id)
    try {
      await githubService.removeConnection(c.id)
      toast.success("Eliminado")
      await loadConnections()
    } catch (e) {
      toast.error((e as Error).message || "No se pudo eliminar")
    } finally {
      setBusyId(null)
    }
  }

  if (!connectedEnabled) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Conecta tu cuenta de GitHub arriba para importar y clonar repositorios.
      </div>
    )
  }

  const connectedRepoIds = new Set(connections.map((c) => c.repoId))

  return (
    <div className="space-y-8">
      {/* Connected workspaces */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Tus workspaces</h2>
          <Button variant="ghost" size="sm" onClick={loadConnections}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {connections.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aún no has importado ningún repositorio.</p>
        ) : (
          <div className="grid gap-2">
            {connections.map((c) => {
              const ready = c.workspace?.status === "ready"
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-sm font-medium">
                      <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{c.fullName}</span>
                      {c.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    </div>
                    <div className="ml-6 flex items-center gap-2 text-xs text-muted-foreground">
                      <GitBranch className="h-3 w-3" /> {c.workspace?.currentBranch || c.defaultBranch} ·{" "}
                      {statusBadge(c.workspace?.status)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ready ? (
                      <Button size="sm" disabled={busyId === c.id} onClick={() => router.push(`/workspace/${c.id}`)}>
                        Abrir
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busyId === c.id} onClick={() => cloneExisting(c)}>
                        {busyId === c.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="mr-1 h-3.5 w-3.5" />
                        )}
                        Clonar
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-500"
                      disabled={busyId === c.id}
                      onClick={() => removeConnection(c)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Create new repo (Phase F) */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Crear repositorio nuevo</h2>
        <form onSubmit={createRepo} className="flex flex-wrap items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="nombre-del-repo"
            className="max-w-xs flex-1"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} />
            Privado
          </label>
          <Button type="submit" disabled={creating || !newName.trim()}>
            {creating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
            Crear y abrir
          </Button>
        </form>
      </section>

      {/* Import from GitHub */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Importar desde GitHub</h2>
        <form onSubmit={runSearch} className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar repositorios… (vacío = tus repos recientes)"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline" disabled={loadingRepos}>
            {loadingRepos ? <Loader2 className="h-4 w-4 animate-spin" /> : "Buscar"}
          </Button>
        </form>

        <div className="grid max-h-[420px] gap-2 overflow-y-auto pr-1">
          {repos.length === 0 && !loadingRepos ? (
            <p className="text-xs text-muted-foreground">Sin resultados.</p>
          ) : (
            repos.map((r) => {
              const already = connectedRepoIds.has(r.repoId)
              return (
                <div
                  key={r.repoId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-sm font-medium">
                      <span className="truncate">{r.fullName}</span>
                      {r.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                      {r.htmlUrl && (
                        <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="text-muted-foreground">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {r.language && <span>{r.language}</span>}
                      {typeof r.stars === "number" && (
                        <span className="inline-flex items-center gap-1">
                          <Star className="h-3 w-3" /> {r.stars}
                        </span>
                      )}
                      {r.description && <span className="truncate">{r.description}</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={already ? "outline" : "default"}
                    disabled={busyId === r.repoId}
                    onClick={() => importRepo(r)}
                  >
                    {busyId === r.repoId ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1 h-3.5 w-3.5" />
                    )}
                    {already ? "Re-clonar" : "Importar"}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </section>
    </div>
  )
}
