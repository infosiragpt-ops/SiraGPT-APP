"use client"

/**
 * /workspace/[id] — Replit-style editor for a cloned GitHub repo.
 *
 *   left:   file tree (real server-side clone)
 *   center: Monaco editor (read/write via the workspace File API)
 *   right:  Git pane (status / stage / commit / push / pull / branches)
 *
 * `id` is the ConnectedRepository id.
 */

import * as React from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  ArrowLeft,
  Loader2,
  Save,
  FileCode2,
  GitBranch,
  Play,
  Square,
  Monitor,
  Terminal,
  ExternalLink,
  Download,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FileTree } from "@/components/workspace/file-tree"
import { GitPane } from "@/components/workspace/git-pane"
import { useWorkspaceRun } from "@/lib/use-workspace-run"
import {
  githubService,
  type FileNode,
  type ConnectedRepository,
} from "@/lib/github-service"

const MonacoCodeArea = dynamic(() => import("@/components/code/monaco-code-area"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  ),
})

function extOf(path: string): string {
  const m = path.match(/\.([^.\\/]+)$/)
  return m ? m[1].toLowerCase() : "plaintext"
}

export default function WorkspaceEditorPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [connection, setConnection] = React.useState<ConnectedRepository | null>(null)
  const [tree, setTree] = React.useState<FileNode[]>([])
  const [loadingTree, setLoadingTree] = React.useState(true)
  const [activePath, setActivePath] = React.useState<string | null>(null)
  const [content, setContent] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [fileState, setFileState] = React.useState<"idle" | "loading" | "binary" | "tooLarge">("idle")
  const [saving, setSaving] = React.useState(false)
  const [tab, setTab] = React.useState<"editor" | "preview" | "console" | "git">("editor")

  const { run, busy: runBusy, start: startRun, stop: stopRun } = useWorkspaceRun(id)

  const dirty = content !== original && fileState === "idle"

  const loadTree = React.useCallback(async () => {
    setLoadingTree(true)
    try {
      const { tree: t } = await githubService.files(id)
      setTree(t)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo cargar el árbol de archivos")
    } finally {
      setLoadingTree(false)
    }
  }, [id])

  React.useEffect(() => {
    void loadTree()
    githubService
      .listConnected()
      .then(({ connections }) => setConnection(connections.find((c) => c.id === id) || null))
      .catch(() => {})
  }, [id, loadTree])

  const openFile = React.useCallback(
    async (path: string) => {
      setActivePath(path)
      setFileState("loading")
      try {
        const f = await githubService.readFile(id, path)
        if (f.binary) {
          setFileState("binary")
          setContent("")
          setOriginal("")
        } else if (f.tooLarge) {
          setFileState("tooLarge")
          setContent("")
          setOriginal("")
        } else {
          setFileState("idle")
          setContent(f.content || "")
          setOriginal(f.content || "")
        }
      } catch (e) {
        toast.error((e as Error).message || "No se pudo abrir el archivo")
        setFileState("idle")
      }
    },
    [id],
  )

  const save = React.useCallback(async () => {
    if (!activePath || !dirty) return
    setSaving(true)
    try {
      await githubService.writeFile(id, activePath, content)
      setOriginal(content)
      toast.success("Guardado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo guardar")
    } finally {
      setSaving(false)
    }
  }, [activePath, content, dirty, id])

  // Ctrl/Cmd+S to save
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [save])

  const newFile = async () => {
    const path = prompt("Ruta del nuevo archivo (p.ej. src/nuevo.ts):")?.trim()
    if (!path) return
    try {
      await githubService.writeFile(id, path, "")
      await loadTree()
      await openFile(path)
      toast.success("Archivo creado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo crear")
    }
  }

  const newFolder = async () => {
    const path = prompt("Ruta de la nueva carpeta:")?.trim()
    if (!path) return
    try {
      await githubService.createFolder(id, path)
      await loadTree()
      toast.success("Carpeta creada")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo crear")
    }
  }

  const renameEntry = async (path: string) => {
    const to = prompt("Nueva ruta:", path)?.trim()
    if (!to || to === path) return
    try {
      await githubService.rename(id, path, to)
      await loadTree()
      if (activePath === path) await openFile(to)
      toast.success("Renombrado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo renombrar")
    }
  }

  const deleteEntry = async (path: string) => {
    if (!confirm(`¿Eliminar ${path}?`)) return
    try {
      await githubService.deleteFile(id, path)
      await loadTree()
      if (activePath === path) {
        setActivePath(null)
        setContent("")
        setOriginal("")
      }
      toast.success("Eliminado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo eliminar")
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-3">
          <Link href="/workspace" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <span className="flex items-center gap-2 text-sm font-medium">
            <FileCode2 className="h-4 w-4 text-muted-foreground" />
            {connection?.fullName || "Workspace"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-500">● sin guardar</span>}
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            Guardar
          </Button>
          <Button
            size="sm"
            variant="outline"
            title="Descargar todo el código (.zip)"
            onClick={() => {
              toast.info("Preparando descarga…")
              githubService
                .downloadZip(id, `${connection?.name || "workspace"}.zip`)
                .catch((e) => toast.error((e as Error).message || "Descarga fallida"))
            }}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            Descargar
          </Button>
          {run.running ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={runBusy}
              onClick={() => {
                void stopRun()
              }}
            >
              {runBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3.5 w-3.5" />}
              Detener
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={runBusy}
              onClick={() => {
                void startRun()
                setTab("preview")
              }}
            >
              {runBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              Ejecutar
            </Button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <aside className="w-60 shrink-0 border-r border-border">
          {loadingTree ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <FileTree
              tree={tree}
              activePath={activePath}
              onOpen={openFile}
              onNewFile={newFile}
              onNewFolder={newFolder}
              onRename={renameEntry}
              onDelete={deleteEntry}
              onRefresh={loadTree}
            />
          )}
        </aside>

        {/* Center: tabs (Editor / Git) */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2">
            <button
              className={cn(
                "border-b-2 px-3 py-2 text-sm",
                tab === "editor" ? "border-sky-500 text-foreground" : "border-transparent text-muted-foreground",
              )}
              onClick={() => setTab("editor")}
            >
              {activePath ? activePath.split("/").pop() : "Editor"}
              {dirty && tab === "editor" ? " ●" : ""}
            </button>
            <button
              className={cn(
                "flex items-center gap-1 border-b-2 px-3 py-2 text-sm",
                tab === "preview" ? "border-sky-500 text-foreground" : "border-transparent text-muted-foreground",
              )}
              onClick={() => setTab("preview")}
            >
              <Monitor className="h-3.5 w-3.5" /> Preview
              {run.status === "ready" && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            </button>
            <button
              className={cn(
                "flex items-center gap-1 border-b-2 px-3 py-2 text-sm",
                tab === "console" ? "border-sky-500 text-foreground" : "border-transparent text-muted-foreground",
              )}
              onClick={() => setTab("console")}
            >
              <Terminal className="h-3.5 w-3.5" /> Console
            </button>
            <button
              className={cn(
                "flex items-center gap-1 border-b-2 px-3 py-2 text-sm",
                tab === "git" ? "border-sky-500 text-foreground" : "border-transparent text-muted-foreground",
              )}
              onClick={() => setTab("git")}
            >
              <GitBranch className="h-3.5 w-3.5" /> Git
            </button>
          </div>

          <div className="min-h-0 flex-1">
            {tab === "git" ? (
              <div className="mx-auto h-full max-w-2xl">
                <GitPane
                  id={id}
                  repoFullName={connection?.fullName}
                  repoUrl={connection?.htmlUrl}
                  onAfterCommit={loadTree}
                />
              </div>
            ) : tab === "preview" ? (
              <div className="h-full">
                {run.status === "ready" && run.previewUrl ? (
                  <div className="flex h-full flex-col">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{run.previewUrl}</span>
                      <a
                        href={run.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" /> Abrir
                      </a>
                    </div>
                    <iframe
                      src={run.previewUrl}
                      title="Preview"
                      className="h-full w-full flex-1 border-0 bg-white"
                      allow="clipboard-write"
                    />
                  </div>
                ) : run.status === "starting" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    Iniciando servidor… {run.tail?.[run.tail.length - 1] || ""}
                  </div>
                ) : run.status === "error" ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-500">
                    {run.error || "El servidor de desarrollo falló. Revisa la consola."}
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                    <Monitor className="h-8 w-8 opacity-40" />
                    Pulsa <span className="font-medium text-emerald-600">▶ Ejecutar</span> para ver tu app en vivo.
                  </div>
                )}
              </div>
            ) : tab === "console" ? (
              <div className="h-full overflow-y-auto bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                {run.tail && run.tail.length > 0 ? (
                  run.tail.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">
                      {line}
                    </div>
                  ))
                ) : (
                  <div className="text-zinc-500">Sin salida. Ejecuta el proyecto para ver los logs.</div>
                )}
              </div>
            ) : !activePath ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Selecciona un archivo para editarlo
              </div>
            ) : fileState === "loading" ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : fileState === "binary" ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Archivo binario — no se puede mostrar
              </div>
            ) : fileState === "tooLarge" ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Archivo demasiado grande para el editor
              </div>
            ) : (
              <MonacoCodeArea value={content} language={extOf(activePath)} onChange={setContent} path={activePath} />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
