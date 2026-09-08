"use client"

/**
 * Minimal coding IDE shell on /agentes (AGENTES_CODING_V2).
 * File tree + Monaco + diff + terminal stub. Never mounts unless the
 * health gate already resolved enabled:true.
 */

import * as React from "react"
import dynamic from "next/dynamic"

import { CodingTerminalPane } from "@/components/agentes/coding-terminal-pane"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  AgentesCodingApiError,
  agentesCodingApi,
  type CodingFileEntry,
  type CodingSession,
  type CodingRepoMapHint,
} from "@/lib/agentes-coding/api"
import { buildFileTree, applyMapHints, languageFromPath, type FileTreeNode } from "@/lib/agentes-coding/file-tree"
import { cn } from "@/lib/utils"

const MonacoCodeArea = dynamic(() => import("@/components/code/monaco-code-area"), { ssr: false })
const CodingMonacoDiff = dynamic(() => import("@/components/agentes/coding-monaco-diff"), { ssr: false })

type Pane = "editor" | "diff" | "terminal"

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
    if (!session || !activePath) return
    setBusy(true)
    setError("")
    try {
      await agentesCodingApi.writeFile(session.id, activePath, draft)
      setOriginal(draft)
      await refreshFiles(session.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateFile() {
    if (!session) return
    const path = newPath.trim().replace(/^\/+/, "")
    if (!path) {
      setError("Indica una ruta de archivo.")
      return
    }
    setBusy(true)
    setError("")
    try {
      await agentesCodingApi.writeFile(session.id, path, draft && activePath === path ? draft : "")
      await refreshFiles(session.id)
      await openFile(path)
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
          {session ? `Sesión ${session.id}` : "Sin sesión"}
        </span>
        {busy ? <ThinkingIndicator size="xs" label="Cargando" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
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
            disabled={busy || !session || !activePath || !dirty}
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
          <p className="px-3 py-2 text-xs font-medium">Archivos</p>
          <div className="flex gap-1 px-2 pb-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="ruta/archivo.ts"
              aria-label="Ruta del archivo"
              disabled={!session || busy}
            />
            <button
              type="button"
              className="h-8 rounded-md border border-border px-2 text-xs"
              onClick={handleCreateFile}
              disabled={!session || busy}
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
                    onClick={() => openFile(hint.path)}
                  >
                    {hint.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {session && files.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">Sin archivos. Crea uno para empezar.</p>
          ) : null}
          {!session ? (
            <p className="px-3 text-xs text-muted-foreground">Crea una sesión para listar archivos.</p>
          ) : null}
          <FileTreeList nodes={tree} activePath={activePath} onOpen={openFile} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2">
            <PaneTab current={pane} id="editor" onSelect={setPane}>Editor</PaneTab>
            <PaneTab current={pane} id="diff" onSelect={setPane}>Diferencias</PaneTab>
            <PaneTab current={pane} id="terminal" onSelect={setPane}>Terminal</PaneTab>
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
