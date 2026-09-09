"use client"

/**
 * Minimal coding IDE shell on /agentes (AGENTES_CODING_V2).
 * File tree + Monaco + diff + terminal stub + project preview (Etapa 4 MVP).
 * The tree auto-refreshes (poll + focus + manual) because the chat agent
 * writes to the project behind the IDE's back (project_write, Etapa 3).
 * Never mounts unless the health gate already resolved enabled:true.
 */

import * as React from "react"
import dynamic from "next/dynamic"
import { useParams } from "next/navigation"

import { CodingPreviewPane } from "@/components/agentes/coding-preview-pane"
import { CodingTerminalPane } from "@/components/agentes/coding-terminal-pane"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  AgentesCodingApiError,
  agentesCodingApi,
  type CodingFileEntry,
  type CodingSession,
  type CodingRepoMapHint,
} from "@/lib/agentes-coding/api"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import type { CodexProject } from "@/lib/codex/api/types"
import { buildFileTree, applyMapHints, languageFromPath, type FileTreeNode } from "@/lib/agentes-coding/file-tree"
import { cn } from "@/lib/utils"

const MonacoCodeArea = dynamic(() => import("@/components/code/monaco-code-area"), { ssr: false })
const CodingMonacoDiff = dynamic(() => import("@/components/agentes/coding-monaco-diff"), { ssr: false })

type Pane = "editor" | "diff" | "terminal" | "preview"

export function CodingIdeShell() {
  const [open, setOpen] = React.useState(true)
  const [pane, setPane] = React.useState<Pane>("editor")
  const [sideBySide, setSideBySide] = React.useState(true)
  const [session, setSession] = React.useState<CodingSession | null>(null)
  const [files, setFiles] = React.useState<CodingFileEntry[]>([])
  const [activePath, setActivePath] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [draft, setDraft] = React.useState("")
  const [newPath, setNewPath] = React.useState("src/app.ts")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [terminalOut, setTerminalOut] = React.useState("")
  const [mapHints, setMapHints] = React.useState<CodingRepoMapHint[]>([])
  // Modo proyecto (MVP programación web): un CodexProject durable vinculado
  // al chat actual. Sin proyecto abierto, el shell conserva su modo sesión.
  const routeParams = useParams()
  const chatId = typeof routeParams?.id === "string" ? routeParams.id : ""
  const [project, setProject] = React.useState<CodexProject | null>(null)
  const [projects, setProjects] = React.useState<CodexProject[]>([])
  const [projectName, setProjectName] = React.useState("")
  const projectId = project?.id || null

  const resetEditor = React.useCallback(() => {
    setActivePath("")
    setOriginal("")
    setDraft("")
  }, [])

  async function refreshProjectFiles(id: string) {
    const paths = await projectsCodexApi.listFiles(id)
    setFiles(paths.map((path) => ({ path })))
  }

  // Refs para el auto-refresh (el intervalo no debe ver estado obsoleto).
  const busyRef = React.useRef(busy)
  busyRef.current = busy
  const activePathRef = React.useRef(activePath)
  activePathRef.current = activePath
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const originalRef = React.useRef(original)
  originalRef.current = original
  const projectIdRef = React.useRef(projectId)
  projectIdRef.current = projectId

  // Recarga silenciosa del árbol del proyecto vinculado. Si el archivo
  // abierto no tiene cambios sin guardar, también recarga su contenido
  // (el agente pudo modificarlo vía project_write). Con cambios locales
  // (dirty) nunca se pisa el borrador del usuario.
  const refreshProjectTree = React.useCallback(async ({ silent }: { silent?: boolean } = {}) => {
    const id = projectIdRef.current
    if (!id || busyRef.current) return
    try {
      const paths = await projectsCodexApi.listFiles(id)
      if (projectIdRef.current !== id) return
      setFiles(paths.map((path) => ({ path })))
      const open = activePathRef.current
      if (open && draftRef.current === originalRef.current) {
        try {
          const body = await projectsCodexApi.readFileContent(id, open)
          const content = String(body?.content ?? "")
          if (projectIdRef.current === id && activePathRef.current === open && content !== originalRef.current) {
            setOriginal(content)
            setDraft(content)
          }
        } catch {
          // El archivo pudo borrarse; el árbol ya lo refleja.
        }
      }
    } catch (err) {
      if (!silent) fail(err)
    }
  }, [])

  // Auto-refresh: poll cada 15s + al recuperar el foco. Solo en modo
  // proyecto (las sesiones efímeras solo las toca este IDE).
  React.useEffect(() => {
    if (!projectId) return
    const timer = window.setInterval(() => void refreshProjectTree({ silent: true }), 15_000)
    const onFocus = () => void refreshProjectTree({ silent: true })
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshProjectTree({ silent: true })
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [projectId, refreshProjectTree])

  async function handleManualRefresh() {
    if (busy) return
    setBusy(true)
    try {
      if (projectId) await refreshProjectTree()
      else if (session) await refreshFiles(session.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function openProject(id: string) {
    setBusy(true)
    setError("")
    try {
      const [found, paths] = await Promise.all([
        projectsCodexApi.getProject(id),
        projectsCodexApi.listFiles(id),
      ])
      setProject(found)
      setFiles(paths.map((path) => ({ path })))
      resetEditor()
      setMapHints([])
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function refreshProjects() {
    try {
      setProjects(await projectsCodexApi.listProjects())
    } catch {
      setProjects([])
    }
  }

  // Al entrar a un chat, abre su proyecto vinculado si existe.
  React.useEffect(() => {
    let cancelled = false
    setProject(null)
    resetEditor()
    setFiles([])
    if (!chatId) {
      void refreshProjects()
      return
    }
    void (async () => {
      setBusy(true)
      try {
        const [bound, all] = await Promise.all([
          projectsCodexApi.getProjectByChat(chatId).catch((err: unknown) => {
            if ((err as { status?: unknown })?.status === 404) return null
            throw err
          }),
          projectsCodexApi.listProjects().catch(() => [] as CodexProject[]),
        ])
        if (cancelled) return
        setProjects(all)
        if (bound) {
          setProject(bound)
          await refreshProjectFiles(bound.id)
        }
      } catch (err) {
        if (!cancelled) fail(err)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chatId, resetEditor])

  async function handleEnsureProject() {
    if (!chatId || busy) return
    setBusy(true)
    setError("")
    try {
      const binding = await projectsCodexApi.ensureProjectForChat(chatId, projectName.trim() || undefined)
      setProject(binding.project)
      setProjectName("")
      await refreshProjects()
      await refreshProjectFiles(binding.project.id)
      resetEditor()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const tree = React.useMemo(
    () => applyMapHints(buildFileTree(files), mapHints),
    [files, mapHints],
  )
  const dirty = Boolean(activePath && draft !== original)
  const language = languageFromPath(activePath || newPath)

  function fail(err: unknown) {
    if (err instanceof AgentesCodingApiError) {
      setError(err.message)
      return
    }
    setError(err instanceof Error ? err.message : "Error del editor de código.")
  }

  async function refreshFiles(sessionId: string) {
    const next = await agentesCodingApi.listFiles(sessionId)
    setFiles(next)
  }

  async function openProjectFile(path: string) {
    if (!projectId) return
    setBusy(true)
    setError("")
    try {
      const body = await projectsCodexApi.readFileContent(projectId, path)
      const content = String(body?.content ?? "")
      setActivePath(path)
      setOriginal(content)
      setDraft(content)
      setPane("editor")
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function handleOpenFile(path: string) {
    if (projectId) void openProjectFile(path)
    else void openFile(path)
  }

  async function handleCreateSession() {
    setBusy(true)
    setError("")
    try {
      const next = await agentesCodingApi.createSession()
      setSession(next)
      setActivePath("")
      setOriginal("")
      setDraft("")
      setMapHints([])
      await refreshFiles(next.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleDestroy() {
    if (!session) return
    setBusy(true)
    setError("")
    try {
      await agentesCodingApi.destroy(session.id)
      setSession(null)
      setFiles([])
      setActivePath("")
      setOriginal("")
      setDraft("")
      setTerminalOut("")
      setMapHints([])
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function openFile(path: string) {
    if (!session) return
    setBusy(true)
    setError("")
    try {
      const content = await agentesCodingApi.readFile(session.id, path)
      setActivePath(path)
      setOriginal(content)
      setDraft(content)
      setPane("editor")
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    if (!activePath) return
    setBusy(true)
    setError("")
    try {
      if (projectId) {
        await projectsCodexApi.importFiles(projectId, [{ path: activePath, content: draft }])
        setOriginal(draft)
        await refreshProjectFiles(projectId)
      } else {
        if (!session) return
        await agentesCodingApi.writeFile(session.id, activePath, draft)
        setOriginal(draft)
        await refreshFiles(session.id)
      }
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateFile() {
    const path = newPath.trim().replace(/^\/+/, "")
    if (!path) {
      setError("Indica una ruta de archivo.")
      return
    }
    setBusy(true)
    setError("")
    try {
      if (projectId) {
        await projectsCodexApi.importFiles(projectId, [{ path, content: draft && activePath === path ? draft : "" }])
        await refreshProjectFiles(projectId)
        await openProjectFile(path)
      } else {
        if (!session) return
        await agentesCodingApi.writeFile(session.id, path, draft && activePath === path ? draft : "")
        await refreshFiles(session.id)
        await openFile(path)
      }
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleRepoMap() {
    if (!session) return
    setBusy(true)
    setError("")
    try {
      const mapped = await agentesCodingApi.repoMap(session.id, { limit: 16 })
      setMapHints(mapped.hints)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleExec(command: string) {
    if (!session) return
    setBusy(true)
    setError("")
    try {
      const result = await agentesCodingApi.exec(session.id, command)
      const stdout = result.stdout || ""
      const stderr = result.stderr || ""
      setTerminalOut([`$ ${command}`, stdout, stderr].filter(Boolean).join("\n"))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="absolute inset-x-0 bottom-0 z-20 border-t border-border bg-background">
        <button
          type="button"
          className="flex h-9 w-full items-center justify-between px-3 text-xs"
          onClick={() => setOpen(true)}
          data-testid="agentes-coding-ide-expand"
        >
          <span>Editor de código</span>
          <span className="text-muted-foreground">Mostrar</span>
        </button>
      </div>
    )
  }

  return (
    <section
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[48vh] min-h-[280px] flex-col border-t border-border bg-background shadow-lg"
      data-testid="agentes-coding-ide"
      aria-label="Editor de código"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">Editor de código</h2>
        <span className="text-xs text-muted-foreground" data-testid="agentes-coding-session-label">
          {project ? `Proyecto ${project.name}` : session ? `Sesión ${session.id}` : "Sin sesión"}
        </span>
        <select
          className="h-8 min-w-0 max-w-40 truncate rounded-md border border-border bg-background px-1 text-xs"
          value={projectId || ""}
          onChange={(event) => {
            const id = event.target.value
            if (id) void openProject(id)
          }}
          disabled={busy}
          aria-label="Proyecto"
          data-testid="agentes-coding-project-select"
        >
          <option value="">Mis proyectos…</option>
          {projects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <input
          className="h-8 w-28 rounded-md border border-border bg-background px-2 text-xs"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          placeholder="Nombre app"
          aria-label="Nombre del proyecto"
          disabled={busy || !chatId}
          data-testid="agentes-coding-project-name"
        />
        {busy ? <ThinkingIndicator size="xs" label="Cargando" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleEnsureProject}
            disabled={busy || !chatId}
            title={chatId ? "Crear o abrir el proyecto de este chat" : "Abre un chat para vincular un proyecto"}
            data-testid="agentes-coding-new-project"
          >
            Nuevo proyecto
          </button>
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleCreateSession}
            disabled={busy}
            data-testid="agentes-coding-new-session"
          >
            Nueva sesión
          </button>
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleSave}
            disabled={busy || (!session && !projectId) || !activePath || !dirty}
            data-testid="agentes-coding-save"
          >
            Guardar
          </button>
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleDestroy}
            disabled={busy || !session}
          >
            Cerrar sesión
          </button>
          <button
            type="button"
            className="h-8 rounded-md px-2 text-xs text-muted-foreground"
            onClick={() => setOpen(false)}
            data-testid="agentes-coding-ide-collapse"
          >
            Ocultar
          </button>
        </div>
      </header>

      {error ? (
        <p className="border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-border" data-testid="agentes-coding-file-tree">
          <div className="flex items-center justify-between px-3 py-2">
            <p className="text-xs font-medium">Archivos</p>
            <button
              type="button"
              className="h-6 px-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => void handleManualRefresh()}
              disabled={busy || (!session && !projectId)}
              title="Recargar el árbol de archivos"
              data-testid="agentes-coding-refresh-files"
            >
              Actualizar
            </button>
          </div>
          <div className="flex gap-1 px-2 pb-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="ruta/archivo.ts"
              aria-label="Ruta del archivo"
              disabled={(!session && !projectId) || busy}
            />
            <button
              type="button"
              className="h-8 rounded-md border border-border px-2 text-xs"
              onClick={handleCreateFile}
              disabled={(!session && !projectId) || busy}
            >
              Crear
            </button>
            <button
              type="button"
              className="h-8 rounded-md border border-border px-2 text-xs"
              onClick={handleRepoMap}
              disabled={!session || busy}
              data-testid="agentes-coding-repo-map"
            >
              Mapa
            </button>
          </div>
          {mapHints.length > 0 ? (
            <ul className="px-2 pb-2" data-testid="agentes-coding-repo-map-hints">
              {mapHints.filter((hint) => hint.kind === "file").slice(0, 6).map((hint) => (
                <li key={`${hint.kind}:${hint.path}:${hint.name}`}>
                  <button
                    type="button"
                    className="block w-full truncate px-2 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted/60"
                    onClick={() => handleOpenFile(hint.path)}
                  >
                    {hint.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {(session || projectId) && files.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">Sin archivos. Crea uno para empezar.</p>
          ) : null}
          {!session && !projectId ? (
            <p className="px-3 text-xs text-muted-foreground">Abre un proyecto o crea una sesión para listar archivos.</p>
          ) : null}
          <FileTreeList nodes={tree} activePath={activePath} onOpen={handleOpenFile} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2">
            <PaneTab current={pane} id="editor" onSelect={setPane}>Editor</PaneTab>
            <PaneTab current={pane} id="diff" onSelect={setPane}>Diferencias</PaneTab>
            <PaneTab current={pane} id="terminal" onSelect={setPane}>Terminal</PaneTab>
            <PaneTab current={pane} id="preview" onSelect={setPane}>Vista previa</PaneTab>
            {pane === "diff" ? (
              <button
                type="button"
                className="ml-auto h-8 px-2 text-xs text-muted-foreground"
                onClick={() => setSideBySide((value) => !value)}
              >
                {sideBySide ? "Unificado" : "Lado a lado"}
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {pane === "editor" ? (
              activePath ? (
                <MonacoCodeArea
                  value={draft}
                  language={language}
                  path={activePath}
                  onChange={setDraft}
                />
              ) : (
                <p className="p-3 text-xs text-muted-foreground">
                  Abre un archivo del árbol o crea uno nuevo.
                </p>
              )
            ) : null}
            {pane === "diff" ? (
              activePath ? (
                <CodingMonacoDiff
                  original={original}
                  modified={draft}
                  language={language}
                  path={activePath}
                  sideBySide={sideBySide}
                />
              ) : (
                <p className="p-3 text-xs text-muted-foreground">
                  Abre un archivo para revisar el diff.
                </p>
              )
            ) : null}
            {pane === "terminal" ? (
              <CodingTerminalPane
                sessionId={session?.id || null}
                busy={busy}
                lastOutput={terminalOut}
                onExec={handleExec}
              />
            ) : null}
            {pane === "preview" ? (
              <CodingPreviewPane key={projectId || "none"} projectId={projectId} />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function PaneTab({
  id,
  current,
  onSelect,
  children,
}: {
  id: Pane
  current: Pane
  onSelect: (pane: Pane) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-8 px-2 text-xs",
        current === id ? "border-b-2 border-primary font-medium" : "text-muted-foreground",
      )}
      onClick={() => onSelect(id)}
      data-testid={`agentes-coding-pane-${id}`}
    >
      {children}
    </button>
  )
}

function FileTreeList({
  nodes,
  activePath,
  onOpen,
  depth = 0,
}: {
  nodes: FileTreeNode[]
  activePath: string
  onOpen: (path: string) => void
  depth?: number
}) {
  return (
    <ul className="px-1">
      {nodes.map((node) => (
        <li key={`${node.kind}:${node.path}`}>
          {node.kind === "dir" ? (
            <div>
              <p className="truncate px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
                {node.name}
              </p>
              <FileTreeList
                nodes={node.children || []}
                activePath={activePath}
                onOpen={onOpen}
                depth={depth + 1}
              />
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "block w-full truncate px-2 py-1 text-left text-xs",
                activePath === node.path ? "bg-muted font-medium" : "hover:bg-muted/60",
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onOpen(node.path)}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export default CodingIdeShell
