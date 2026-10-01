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

import { CodingChangesPane } from "@/components/agentes/coding-changes-pane"
import { CodingPreviewPane } from "@/components/agentes/coding-preview-pane"
import { CodingRepoPicker } from "@/components/agentes/coding-repo-picker"
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
import type { CodexCloneResult, CodexEditorFile, CodexProject } from "@/lib/codex/api/types"
import { buildFileTree, applyMapHints, languageFromPath, type FileTreeNode } from "@/lib/agentes-coding/file-tree"
import { cn } from "@/lib/utils"
import { isRuntimeEnvFile, redactSecretsForLogs } from "@/lib/code-secrets"

const MonacoCodeArea = dynamic(() => import("@/components/code/monaco-code-area"), { ssr: false })
const CodingMonacoDiff = dynamic(() => import("@/components/agentes/coding-monaco-diff"), { ssr: false })

type Pane = "editor" | "diff" | "changes" | "terminal" | "preview"

const EDITOR_MAX_BYTES = 500 * 1024
const DRAFT_PREFIX = "siragpt:editor-draft:v1:"
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const REVISION_RE = /^[a-f0-9]{64}$/
type EditorDraft = { original: string; draft: string; revision: string; savedAt: number }

function draftKey(userId: string | undefined, projectId: string | null, path: string): string | null {
  if (!userId || !projectId || !path || isRuntimeEnvFile(path) || /(?:^|\/)(?:\.git|\.ssh)(?:\/|$)|(?:^|\/)(?:id_rsa|id_ed25519)|\.(?:pem|key)$/i.test(path)) return null
  return DRAFT_PREFIX + [userId, projectId, path].map(encodeURIComponent).join(":")
}

function safeDraftText(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= EDITOR_MAX_BYTES &&
    redactSecretsForLogs(text) === text && !/AKIA[A-Z0-9]{16}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)
}

function removeDraft(key: string | null) {
  if (!key) return
  try { window.sessionStorage.removeItem(key) } catch { /* storage can be unavailable */ }
}

function storeDraft(key: string | null, snapshot: EditorDraft) {
  if (!key) return
  if (!safeDraftText(snapshot.original) || !safeDraftText(snapshot.draft)) {
    removeDraft(key)
    return
  }
  try { window.sessionStorage.setItem(key, JSON.stringify(snapshot)) } catch { /* beforeunload still protects the live draft */ }
}

function readDraft(key: string | null): EditorDraft | null {
  if (!key) return null
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw || raw.length > EDITOR_MAX_BYTES * 4) return null
    const snapshot = JSON.parse(raw) as EditorDraft
    if (typeof snapshot.original !== "string" || typeof snapshot.draft !== "string" ||
      typeof snapshot.revision !== "string" || !REVISION_RE.test(snapshot.revision) ||
      !Number.isFinite(snapshot.savedAt) || Date.now() - snapshot.savedAt > DRAFT_MAX_AGE_MS ||
      !safeDraftText(snapshot.original) || !safeDraftText(snapshot.draft)) {
      removeDraft(key)
      return null
    }
    return snapshot
  } catch { return null }
}

function editorReadOnly(body: CodexEditorFile): boolean {
  return body.ok !== true || body.truncated !== false || body.readOnly !== false ||
    typeof body.revision !== "string" || !REVISION_RE.test(body.revision) ||
    !Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 0 || body.sizeBytes > EDITOR_MAX_BYTES
}

function editorError(err: unknown): string {
  const code = (err as { body?: { error?: string } })?.body?.error
  if (code === "file_conflict") return "El archivo cambió en el proyecto. Tu borrador sigue intacto; copia tus cambios y vuelve a abrir el archivo antes de guardar."
  if (code === "run_in_progress" || code === "file_busy") return "El proyecto está trabajando en este archivo. Tu borrador sigue intacto; vuelve a guardar cuando termine."
  if (code === "binary_file") return "Este archivo es binario y no se puede editar como texto."
  if (code === "protected_path") return "Este archivo está protegido y no se puede abrir en el editor."
  if ((err as { status?: number })?.status === 413) return "El archivo supera el límite del editor (500 KB). Tu borrador sigue intacto."
  return err instanceof Error ? err.message : "Error del editor de código."
}

export function CodingIdeShell({ conversationId, userId, initialPane = "editor", previewRevision = 0, embedded = false, onClose, onProjectReady }: {
  conversationId?: string
  userId?: string
  initialPane?: "editor" | "preview"
  previewRevision?: number
  embedded?: boolean
  onClose?: () => void
  onProjectReady?: (ready: boolean) => void
} = {}) {
  const [open, setOpen] = React.useState(true)
  const [pane, setPane] = React.useState<Pane>(initialPane)
  const [sideBySide, setSideBySide] = React.useState(true)
  const [session, setSession] = React.useState<CodingSession | null>(null)
  const [files, setFiles] = React.useState<CodingFileEntry[]>([])
  // fileVersion sube solo cuando el árbol/contenido del proyecto cambia de
  // verdad (hot-restart del preview, Etapa 5). Los polls sin cambios no
  // recargan nada.
  const [fileVersion, setFileVersion] = React.useState(0)
  const [activePath, setActivePath] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [draft, setDraft] = React.useState("")
  const [revision, setRevision] = React.useState<string | null>(null)
  const [editorLocked, setEditorLocked] = React.useState(false)
  const mountedRef = React.useRef(true)
  const editorEpochRef = React.useRef(0)
  const draftOwnerRef = React.useRef<{ userId?: string; projectId: string; path: string } | null>(null)
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; editorEpochRef.current += 1 }
  }, [])
  const [newPath, setNewPath] = React.useState("src/app.ts")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [terminalOut, setTerminalOut] = React.useState("")
  const [mapHints, setMapHints] = React.useState<CodingRepoMapHint[]>([])
  // Modo proyecto (MVP programación web): un CodexProject durable vinculado
  // al chat actual. Sin proyecto abierto, el shell conserva su modo sesión.
  const routeParams = useParams()
  const chatId = conversationId ?? (typeof routeParams?.id === "string" ? routeParams.id : "")
  const [project, setProject] = React.useState<CodexProject | null>(null)
  const [projects, setProjects] = React.useState<CodexProject[]>([])
  const [projectName, setProjectName] = React.useState("")
  const projectId = project?.id || null
  React.useEffect(() => { onProjectReady?.(Boolean(projectId)) }, [projectId, onProjectReady])

  const resetEditor = React.useCallback(() => {
    editorEpochRef.current += 1
    draftOwnerRef.current = null
    setRevision(null)
    setEditorLocked(false)
    setActivePath("")
    setOriginal("")
    setDraft("")
  }, [])

  async function refreshProjectFiles(id: string, mutated = false) {
    const epoch = editorEpochRef.current
    if (mutated) setFileVersion((v) => v + 1)
    const paths = await projectsCodexApi.listFiles(id)
    if (!mountedRef.current || editorEpochRef.current !== epoch || (projectIdRef.current && projectIdRef.current !== id)) return
    filesSigRef.current = paths.join("\0")
    setFiles(paths.map((path) => ({ path })))
  }

  // Firma del último árbol conocido del proyecto: base para detectar
  // cambios reales y subir fileVersion (hot-restart del preview).
  const filesSigRef = React.useRef("")

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

  // Only unsaved drafts are kept in this browser tab, scoped to account,
  // project and file. Server revisions remain attached to recovered drafts.
  React.useEffect(() => {
    const owner = draftOwnerRef.current
    if (!owner || owner.userId !== userId || owner.projectId !== projectId || owner.path !== activePath) return
    const key = draftKey(userId, projectId, activePath)
    if (draft === original) { removeDraft(key); return }
    if (editorLocked || !revision) return
    storeDraft(key, { original, draft, revision, savedAt: Date.now() })
  }, [userId, projectId, activePath, original, draft, revision, editorLocked])

  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draftRef.current === originalRef.current) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  function discardDraft() {
    removeDraft(draftKey(userId, projectId, activePath))
  }

  // Recarga silenciosa del árbol del proyecto vinculado. Si el archivo
  // abierto no tiene cambios sin guardar, también recarga su contenido
  // (el agente pudo modificarlo vía project_write). Con cambios locales
  // (dirty) nunca se pisa el borrador del usuario.
  const refreshProjectTree = React.useCallback(async ({ silent }: { silent?: boolean } = {}) => {
    const id = projectIdRef.current
    const epoch = editorEpochRef.current
    if (!id || busyRef.current) return
    try {
      const paths = await projectsCodexApi.listFiles(id)
      if (!mountedRef.current || editorEpochRef.current !== epoch || projectIdRef.current !== id) return
      const sig = paths.join("\0")
      if (sig !== filesSigRef.current) {
        filesSigRef.current = sig
        setFileVersion((v) => v + 1)
      }
      setFiles(paths.map((path) => ({ path })))
      const open = activePathRef.current
      if (open && draftRef.current === originalRef.current) {
        try {
          const body = await projectsCodexApi.readEditorFile(id, open)
          const content = String(body?.content ?? "")
          if (mountedRef.current && editorEpochRef.current === epoch && projectIdRef.current === id && activePathRef.current === open && draftRef.current === originalRef.current) {
            const locked = editorReadOnly(body)
            setEditorLocked(locked)
            setRevision(body.revision)
            if (locked) {
              setError("Este archivo no se puede cargar completo para editarlo (máximo 500 KB). Se mantiene en solo lectura.")
              return
            }
            if (content === originalRef.current) return
            setOriginal(content)
            setDraft(content)
            // El agente cambió el contenido sin tocar el árbol: también
            // cuenta como cambio para el hot-restart del preview.
            setFileVersion((v) => v + 1)
          }
        } catch (err) {
          if (mountedRef.current && editorEpochRef.current === epoch && projectIdRef.current === id && activePathRef.current === open &&
            draftRef.current === originalRef.current && (err as { status?: number })?.status === 415) {
            setEditorLocked(true)
            setError(editorError(err))
          }
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
    if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Descartarlos y abrir otro proyecto?")) return
    if (dirty) discardDraft()
    setBusy(true)
    setError("")
    const epoch = editorEpochRef.current
    try {
      const [found, paths] = await Promise.all([
        projectsCodexApi.getProject(id),
        projectsCodexApi.listFiles(id),
      ])
      if (!mountedRef.current || editorEpochRef.current !== epoch) return
      setProject(found)
      filesSigRef.current = paths.join("\0")
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
    const epoch = editorEpochRef.current
    try {
      const all = await projectsCodexApi.listProjects()
      if (mountedRef.current && editorEpochRef.current === epoch) setProjects(all)
    } catch {
      if (mountedRef.current && editorEpochRef.current === epoch) setProjects([])
    }
  }

  // Al entrar a un chat, abre su proyecto vinculado si existe.
  React.useEffect(() => {
    let cancelled = false
    setProject(null)
    resetEditor()
    filesSigRef.current = ""
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
          const paths = await projectsCodexApi.listFiles(bound.id)
          if (cancelled) return
          filesSigRef.current = paths.join("\0")
          setFiles(paths.map((path) => ({ path })))
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
  }, [chatId, userId, resetEditor])

  async function handleEnsureProject() {
    if (!chatId || busy) return
    setBusy(true)
    setError("")
    const epoch = editorEpochRef.current
    try {
      const binding = await projectsCodexApi.ensureProjectForChat(chatId, projectName.trim() || undefined)
      if (!mountedRef.current || editorEpochRef.current !== epoch) return
      setProject(binding.project)
      setProjectName("")
      await refreshProjects()
      if (!mountedRef.current || editorEpochRef.current !== epoch) return
      await refreshProjectFiles(binding.project.id)
      if (mountedRef.current && editorEpochRef.current === epoch) resetEditor()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  // Etapa 6: el chat abre un repo de GitHub clonado (ya vinculado por el
  // backend vía brief.chatId). Mismo camino que un proyecto recién creado.
  async function handleRepoBound(result: CodexCloneResult) {
    const epoch = editorEpochRef.current
    setBusy(true)
    setError("")
    try {
      setProject(result.project)
      setProjectName("")
      setMapHints([])
      await refreshProjects()
      if (!mountedRef.current || editorEpochRef.current !== epoch) return
      await refreshProjectFiles(result.project.id)
      if (mountedRef.current && editorEpochRef.current === epoch) resetEditor()
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
  // Monaco retains previously opened models globally. Scope their URIs so
  // a matching filename in another account/project never reuses its text.
  const modelPath = "siragpt-editor://workspace/" + [
    userId || "anonymous",
    projectId ? "project" : "session",
    projectId || session?.id || "unbound",
    ...activePath.split("/"),
  ].map(encodeURIComponent).join("/")

  function fail(err: unknown) {
    if (err instanceof AgentesCodingApiError) {
      setError(err.message)
      return
    }
    setError(editorError(err))
  }

  async function refreshFiles(sessionId: string) {
    const next = await agentesCodingApi.listFiles(sessionId)
    setFiles(next)
  }

  async function openProjectFile(path: string) {
    if (!projectId) return
    setBusy(true)
    setError("")
    const id = projectId
    const epoch = editorEpochRef.current
    try {
      const body = await projectsCodexApi.readEditorFile(id, path)
      if (!mountedRef.current || editorEpochRef.current !== epoch || projectIdRef.current !== id) return
      const content = String(body?.content ?? "")
      const locked = editorReadOnly(body)
      const recovered = !locked ? readDraft(draftKey(userId, id, path)) : null
      draftOwnerRef.current = { userId, projectId: id, path }
      setActivePath(path)
      setEditorLocked(locked)
      setRevision(recovered?.revision ?? body.revision)
      setOriginal(recovered?.original ?? content)
      setDraft(recovered?.draft ?? content)
      setPane("editor")
      if (locked) setError("Este archivo no se puede cargar completo para editarlo (máximo 500 KB). Se mantiene en solo lectura.")
      else if (recovered) setError(recovered.revision !== body.revision
        ? "Recuperé tu borrador. El archivo cambió en el proyecto; revisa los cambios antes de guardar."
        : "Recuperé el borrador que tenías sin guardar en esta pestaña.")
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function handleOpenFile(path: string) {
    if (busy || (dirty && !window.confirm("Tienes cambios sin guardar. ¿Descartarlos y abrir otro archivo?"))) return
    if (dirty) discardDraft()
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
      setEditorLocked(false)
      setRevision(null)
      draftOwnerRef.current = null
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
    if (!activePath || busy || editorLocked || (projectId && !revision)) return
    setBusy(true)
    setError("")
    try {
      if (projectId) {
        const id = projectId, path = activePath, savedDraft = draft
        const epoch = editorEpochRef.current
        await projectsCodexApi.saveWorkspaceFile(id, { path, content: savedDraft, expectedRevision: revision })
        if (mountedRef.current && editorEpochRef.current === epoch && projectIdRef.current === id) {
          setFileVersion((value) => value + 1)
        }
        const verified = await projectsCodexApi.readEditorFile(id, path)
        if (editorReadOnly(verified) || verified.content !== savedDraft) {
          throw new Error("No pude confirmar el contenido guardado. Tu borrador sigue intacto; vuelve a abrir el archivo para comprobarlo.")
        }
        removeDraft(draftKey(userId, id, path))
        if (!mountedRef.current || editorEpochRef.current !== epoch || projectIdRef.current !== id) return
        setRevision(verified.revision)
        setOriginal(savedDraft)
        await refreshProjectFiles(id)
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
    if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Descartarlos y crear otro archivo?")) return
    if (dirty) discardDraft()
    const path = newPath.trim().replace(/^\/+/, "")
    if (!path) {
      setError("Indica una ruta de archivo.")
      return
    }
    setBusy(true)
    setError("")
    const epoch = editorEpochRef.current
    try {
      if (projectId) {
        const existing = await projectsCodexApi.listFiles(projectId)
        if (!mountedRef.current || editorEpochRef.current !== epoch) return
        if (existing.includes(path)) throw new Error("Ese archivo ya existe. Ábrelo para editarlo.")
        await projectsCodexApi.saveWorkspaceFile(projectId, { path, content: "", expectedRevision: null })
        if (!mountedRef.current || editorEpochRef.current !== epoch) return
        await refreshProjectFiles(projectId, true)
        if (mountedRef.current && editorEpochRef.current === epoch) await openProjectFile(path)
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
    if ((!session && !projectId) || busy) return
    setBusy(true)
    setError("")
    try {
      const result = projectId
        ? await projectsCodexApi.execInProject(projectId, command)
        : await agentesCodingApi.exec(session!.id, command)
      const stdout = result.stdout || ""
      const stderr = result.stderr || ""
      setTerminalOut([`$ ${command}`, stdout, stderr,
        "timedOut" in result && result.timedOut ? "Tiempo de ejecución agotado." : `Código de salida: ${result.exitCode ?? "desconocido"}`,
      ].filter(Boolean).join("\n"))
      if (projectId) await refreshProjectFiles(projectId, true)
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
      className={cn("flex min-h-0 flex-col border-l border-border bg-background", embedded ? "h-full" : "absolute inset-x-0 bottom-0 z-20 max-h-[48vh] min-h-[280px] border-t shadow-lg")}
      data-testid="agentes-coding-ide"
      aria-label="Editor de código"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">Editor de código</h2>
        <span className="text-xs text-muted-foreground" data-testid="agentes-coding-session-label">
          {project ? `Proyecto ${project.name}` : session ? `Sesión ${session.id}` : embedded ? "Vincula un proyecto a este chat" : "Sin sesión"}
        </span>
        {!embedded && <select
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
        </select>}
        {(!embedded || !projectId) && <input
          className="h-8 w-28 rounded-md border border-border bg-background px-2 text-xs"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          placeholder="Nombre app"
          aria-label="Nombre del proyecto"
          disabled={busy || !chatId}
          data-testid="agentes-coding-project-name"
        />}
        {(!embedded || !projectId) && <CodingRepoPicker
          chatId={chatId}
          sourceControl={project?.sourceControl ?? null}
          disabled={busy || !chatId}
          onBound={handleRepoBound}
        />}
        {busy ? <ThinkingIndicator size="xs" label="Cargando" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {(!embedded || !projectId) && <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleEnsureProject}
            disabled={busy || !chatId}
            title={chatId ? "Crear o abrir el proyecto de este chat" : "Abre un chat para vincular un proyecto"}
            data-testid="agentes-coding-new-project"
          >
            Nuevo proyecto
          </button>}
          {!embedded && <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleCreateSession}
            disabled={busy}
            data-testid="agentes-coding-new-session"
          >
            Nueva sesión
          </button>}
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleSave}
            disabled={busy || editorLocked || (Boolean(projectId) && !revision) || (!session && !projectId) || !activePath || !dirty}
            data-testid="agentes-coding-save"
          >
            Guardar
          </button>
          {!embedded && <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-xs"
            onClick={handleDestroy}
            disabled={busy || !session}
          >
            Cerrar sesión
          </button>}
          <button
            type="button"
            className="h-8 rounded-md px-2 text-xs text-muted-foreground"
            onClick={() => {
              if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Cerrar el editor y descartarlos?")) return
              if (dirty) discardDraft()
              if (onClose) onClose()
              else setOpen(false)
            }}
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(100px,28%)_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-border" data-testid="agentes-coding-file-tree">
          <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-2">
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
          <div className="flex flex-wrap gap-1 px-2 pb-2">
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
            {!embedded && <button
              type="button"
              className="h-8 rounded-md border border-border px-2 text-xs"
              onClick={handleRepoMap}
              disabled={!session || busy}
              data-testid="agentes-coding-repo-map"
            >
              Mapa
            </button>}
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
            <p className="px-3 text-xs text-muted-foreground">Crea un proyecto o conecta un repositorio. Después pide los cambios desde este chat.</p>
          ) : null}
          <FileTreeList nodes={tree} activePath={activePath} onOpen={handleOpenFile} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
            <PaneTab current={pane} id="editor" onSelect={setPane}>Editor</PaneTab>
            <PaneTab current={pane} id="diff" onSelect={setPane}>Diferencias</PaneTab>
            <PaneTab current={pane} id="changes" onSelect={setPane}>Cambios</PaneTab>
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
                  path={modelPath}
                  onChange={setDraft}
                  readOnly={busy || editorLocked}
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
            {pane === "changes" ? (
              <CodingChangesPane
                projectId={projectId}
                sourceControl={project?.sourceControl ?? null}
                fileVersion={fileVersion}
                onOpenFile={handleOpenFile}
              />
            ) : null}
            {pane === "terminal" ? (
              <CodingTerminalPane
                sessionId={projectId || session?.id || null}
                busy={busy}
                lastOutput={terminalOut}
                onExec={handleExec}
              />
            ) : null}
            {pane === "preview" ? (
              <CodingPreviewPane key={projectId || "none"} projectId={projectId} fileVersion={fileVersion} previewRevision={previewRevision} />
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
        "h-8 shrink-0 whitespace-nowrap px-2 text-xs",
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
