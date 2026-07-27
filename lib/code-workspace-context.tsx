"use client"

/**
 * CodeWorkspaceProvider — single-source-of-truth for the /code page.
 *
 * Responsibilities:
 *
 *   - Holds the in-memory file system used by the editor and chat.
 *   - Persists files + open tabs to localStorage so a refresh keeps
 *     the workspace state. Tied to a small version key so we can
 *     evolve the schema later without crashing existing users.
 *   - Exposes a stable callback API. Components (file tree, editor,
 *     chat, command palette) talk to the provider, never to each
 *     other, so the workspace stays composable.
 *
 * Intentionally NOT included here:
 *
 *   - No network calls. Streaming the AI chat lives in the chat panel
 *     itself (so cancellation lifetimes match the panel's lifetime).
 *   - No code execution / sandboxing. Preview is delegated to the
 *     existing ArtifactPanel sandbox in the chat side of the app.
 */

import * as React from "react"
import { toast } from "sonner"

import {
  CodeFile,
  CodeFiles,
  defaultStarterFiles,
  languageForPath,
  normalizePath,
} from "./code-workspace-utils"
import {
  CODEX_UPDATED_EVENT,
  codexIdForLocalFolder,
  codexIdForProject,
  listCodexProjects,
  upsertCodexProject,
} from "./codex-projects"
import { projectsService } from "./projects-service"
import { mirrorWrite, mirrorDelete, mirrorRename, setMirrorSuppressed } from "./code-git-mirror"
import {
  canOpenLocalDirectory,
  getLinkedLocalFolderName,
  hasLinkedLocalFolder,
  type LocalWorkspaceImport,
  openLocalDirectoryWorkspace,
  readLocalFolderViaInput,
  saveLinkedWorkspaceFile,
} from "./local-folder-workspace"
import {
  CODE_CHAT_SESSIONS_UPDATED_EVENT,
  type CodeChatSession,
  type CodeChatTurn,
  codeWorkspaceKey,
  codexWorkspaceSessionKey,
  createCodeChatSession as createCodeChatSessionRecord,
  createCodeChatSessionId,
  ensureDefaultSession,
  getActiveSessionId,
  listSessionsForWorkspace,
  readCodeChatStore,
  setActiveCodeChatSession as setActiveCodeChatSessionRecord,
  updateCodeChatSessionTurns,
  updateCodeChatSessionAgent,
} from "./code-chat-sessions"
import type { AgentState } from "./code-agent/types"
import { readWorkspaceCodexProject } from "./codex/codex-project-link"

export const SWITCH_CODEX_WORKSPACE_EVENT = "siragpt:switch-codex-workspace"
/** Fired (with detail {id}) when a workspace is deleted elsewhere (e.g. the app
 *  sidebar) so the open /code workspace drops it from state and resets if active. */
export const FORGET_CODEX_WORKSPACE_EVENT = "siragpt:forget-codex-workspace"
export const TOGGLE_CODEX_SIDEBAR_EVENT = "siragpt:toggle-codex-sidebar"
export const CODE_ACTIVITY_EVENT = "siragpt:code-activity"
export const CODE_NEW_CODE_CHAT_EVENT = "siragpt:code-new-code-chat"
export const CODE_SELECT_CHAT_SESSION_EVENT = "siragpt:code-select-chat-session"
export const CODE_OPEN_TOOL_EVENT = "siragpt:code-open-tool"
export const CODE_OPEN_TOOL_LAUNCHER_EVENT = "siragpt:code-open-tool-launcher"
// Broadcast the host-runner run id whenever a real dev server starts/stops, so
// the Shell tool can exec real commands against that run's workspace. detail:
// { runId: string | null } — null means no live host run (fall back to the
// client-side pseudo-shell).
export const CODE_RUNNER_ACTIVE_EVENT = "siragpt:code-runner-active"
export const CODE_PREVIEW_STATE_EVENT = "siragpt:code-preview-state"

export type CodePreviewState = {
  phase: "idle" | "starting" | "ready" | "error" | "stuck"
  src: string
  staticHtml: string
  note: string
  kind: string
  entry: string | null
}

// The event is fire-and-forget, so a tool that mounts AFTER the run started
// (e.g. opening the Shell once the preview is already live) would miss it. Keep
// the last value in a module singleton + a setter that both stores and
// broadcasts, so late consumers can read the current run on mount.
let _activeHostRunId: string | null = null
export function setActiveHostRunId(runId: string | null) {
  _activeHostRunId = runId
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CODE_RUNNER_ACTIVE_EVENT, { detail: { runId } }))
  }
}
export function getActiveHostRunId(): string | null {
  return _activeHostRunId
}

// Codex-backed chats build in a SERVER-side workspace (the codex runner), so
// the preview must iframe that runner's tokenized proxy — pushing the local
// virtual FS to the host runner would run a stale/partial copy. The chat panel
// stores the resolved codex project here; PreviewPane checks it before the
// host-runner path. Same late-consumer singleton pattern as the host run id.
let _activeCodexProjectId: string | null = null
export const CODE_ACTIVE_CODEX_PROJECT_EVENT = "siragpt:active-codex-project"
export function setActiveCodexProject(projectId: string | null) {
  _activeCodexProjectId = projectId
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CODE_ACTIVE_CODEX_PROJECT_EVENT, { detail: { projectId } }),
    )
  }
}
export function getActiveCodexProject(): string | null {
  return _activeCodexProjectId
}

export type CodeNewChatDetail = {
  workspaceId: string
  name: string
  kind: "local-folder" | "project"
  projectId?: string
  title?: string
}

const STORAGE_KEY = "code-workspace:v1"
const STORAGE_ACTIVE_FOLDER = "code-workspace:active-folder"

type PersistedState = {
  files: CodeFiles
  openTabs: string[]
  activePath: string | null
}

export type ActiveFolder = {
  id: string
  name: string
  description?: string | null
  instructions?: string | null
}

export type WorkspaceSource = {
  kind: "starter" | "browser" | "local-folder"
  name: string
  linked: boolean
  fileCount?: number
  skippedCount?: number
}

type Listener = () => void

type ChatFocusListener = () => void
type CommandPaletteListener = () => void

export type CodeWorkspaceContextValue = {
  files: CodeFiles
  openTabs: string[]
  activePath: string | null

  /** Open or create a file by path. If `content` is provided the file
   *  is created when missing. */
  openFile: (path: string, content?: string) => void
  closeTab: (path: string) => void
  setActiveTab: (path: string) => void

  /** Update the contents of a file. Optionally bump the open-tab
   *  ordering. Calling with the same content is a cheap no-op. */
  updateFile: (path: string, content: string) => void

  createFile: (path: string, content?: string) => void
  renameFile: (oldPath: string, newPath: string) => void
  deleteFile: (path: string) => void

  /** Reset the workspace to the starter project. */
  resetWorkspace: () => void

  /** Delete a workspace folder's local state (persisted files/tabs). If it is
   *  the one currently open, fall back to the starter project. Does NOT touch
   *  the codex registry, the backend project, or the user's disk. */
  forgetWorkspace: (id: string) => void

  /** Open a Desktop/local folder through the browser File System Access
   *  picker and replace the in-memory workspace with compatible files. */
  openLocalFolderWorkspace: () => Promise<void>

  /** Persist a file back to the selected local folder when a folder is
   *  linked. Falls back to browser-local persistence when not linked. */
  saveFileToWorkspace: (path?: string) => Promise<boolean>

  /** Apply a code block from the AI chat to a target path. Creates
   *  the file if it does not exist; otherwise overwrites it. Returns
   *  the resolved path so the caller can open the editor on it. */
  applyBlock: (path: string, content: string) => string

  /** Bulk-replace the workspace files (used to load a bound GitHub repo's
   *  files into the editor). Does NOT mirror back to the clone. */
  hydrateFiles: (files: { path: string; content: string }[]) => void

  /** Imperative bus shared with the chat / command palette. The chat
   *  panel registers a focus handler so ⌘L can move focus into the
   *  composer without prop-drilling refs through three levels. */
  registerChatFocusHandler: (handler: ChatFocusListener) => () => void
  focusChat: () => void

  /** Same imperative-bus pattern for the command palette so any nested
   *  component can request opening it (e.g. an "Open file…" button). */
  registerCommandPaletteHandler: (handler: CommandPaletteListener) => () => void
  openCommandPalette: () => void

  /** The folder/Project that scopes this workspace. Drives the chat
   *  context prompt and the top-bar breadcrumb. */
  activeFolder: ActiveFolder | null
  setActiveFolder: (folder: ActiveFolder | null) => void

  /** Parallel code-agent chats for the active workspace (same files, separate threads). */
  codeChatSessions: CodeChatSession[]
  activeCodeChatSessionId: string | null
  activeCodeChatSession: CodeChatSession | null
  createCodeChatSession: (opts?: { title?: string }) => string
  setActiveCodeChatSession: (sessionId: string) => void
  patchCodeChatSessionTurns: (
    sessionId: string,
    updater: (prev: CodeChatTurn[]) => CodeChatTurn[],
  ) => void
  /** Patch the agent FSM state of a session (intake → generate → debug). */
  patchAgentState: (sessionId: string, updater: (prev: AgentState) => AgentState) => void
  listCodeChatSessionsForWorkspace: (workspaceId: string) => CodeChatSession[]
  openWorkspaceNewCodeChat: (detail: CodeNewChatDetail) => Promise<void>
  workspaceSource: WorkspaceSource

  /** Load a Codex workspace (cloud project or saved local folder). */
  switchCodexWorkspace: (target: {
    id: string
    name: string
    kind: "local-folder" | "project"
    projectId?: string
  }) => Promise<void>
}

const CodeWorkspaceContext = React.createContext<CodeWorkspaceContextValue | null>(null)

/**
 * Persistence is namespaced per active folder so opening a different
 * Project does not clobber the files of another. The legacy
 * `STORAGE_KEY` (without a folder suffix) is treated as the "default"
 * bucket for sessions where the user has not selected a folder yet.
 */
function storageKeyFor(folderId: string | null): string {
  return folderId ? `${STORAGE_KEY}:${folderId}` : STORAGE_KEY
}

function readPersisted(folderId: string | null): PersistedState | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(storageKeyFor(folderId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.files || typeof parsed.files !== "object") return null
    if (!Array.isArray(parsed.openTabs)) return null
    return parsed
  } catch {
    return null
  }
}

function writePersisted(folderId: string | null, state: PersistedState) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKeyFor(folderId), JSON.stringify(state))
  } catch {
    /* quota exceeded or storage disabled — fail soft */
  }
}

function buildInitialStateFor(folderId: string | null): PersistedState {
  const persisted = readPersisted(folderId)
  if (persisted && Object.keys(persisted.files).length > 0) return persisted

  // A brand-new workspace opens CLEAN — no example code, no sample
  // folders. "Proyecto nuevo desde cero" should mean a blank canvas you
  // start working in, not a demo app you have to delete first. The
  // sample project is still one click away via "Restaurar ejemplo"
  // (resetWorkspace) for anyone who wants a reference.
  return { files: {}, openTabs: [], activePath: null }
}

function readStoredActiveFolder(): ActiveFolder | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_ACTIVE_FOLDER)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActiveFolder
    if (parsed && parsed.id && parsed.name) return parsed
    return null
  } catch {
    return null
  }
}

export function CodeWorkspaceProvider({ children }: { children: React.ReactNode }) {
  // Boot the active folder synchronously from localStorage so we can
  // pick the right per-folder bucket on the very first render. Doing
  // it inside an effect would cause a flash of starter files, then a
  // visible swap to the persisted ones.
  const initialFolder = React.useMemo(readStoredActiveFolder, [])
  const [activeFolder, setActiveFolderState] = React.useState<ActiveFolder | null>(initialFolder)
  // Latest active project id, readable from stable callbacks without
  // re-creating them on every folder switch (used by the git mirror).
  const activeFolderIdRef = React.useRef<string | null>(initialFolder?.id ?? null)
  React.useEffect(() => {
    activeFolderIdRef.current = activeFolder?.id ?? null
  }, [activeFolder?.id])
  const [state, setState] = React.useState<PersistedState>(() =>
    buildInitialStateFor(initialFolder?.id ?? null),
  )
  const [workspaceSource, setWorkspaceSource] = React.useState<WorkspaceSource>({
    kind: "browser",
    name: "Workspace del navegador",
    linked: false,
  })
  const chatFocusListeners = React.useRef<Set<Listener>>(new Set())
  const paletteListeners = React.useRef<Set<Listener>>(new Set())
  const lastFolderIdRef = React.useRef<string | null>(initialFolder?.id ?? null)
  const [chatSessionStore, setChatSessionStore] = React.useState(readCodeChatStore)

  const workspaceSessionKey = codexWorkspaceSessionKey(activeFolder?.id)

  React.useEffect(() => {
    // ensureDefaultSession persists its result. Compute it outside React's
    // updater so that storage/event side effects cannot re-enter a render.
    setChatSessionStore(ensureDefaultSession(workspaceSessionKey, readCodeChatStore()))
  }, [workspaceSessionKey])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const sync = () => setChatSessionStore(readCodeChatStore())
    window.addEventListener(CODE_CHAT_SESSIONS_UPDATED_EVENT, sync)
    return () => window.removeEventListener(CODE_CHAT_SESSIONS_UPDATED_EVENT, sync)
  }, [])

  const setActiveFolder = React.useCallback((folder: ActiveFolder | null) => {
    const previousFolderId = lastFolderIdRef.current
    const nextFolderId = folder?.id ?? null
    if (previousFolderId === nextFolderId) {
      // Same folder — only the metadata (description/instructions) may
      // have been re-hydrated from the API. Keep the file state intact.
      setActiveFolderState(folder)
      if (typeof window !== "undefined") {
        try {
          if (folder) window.localStorage.setItem(STORAGE_ACTIVE_FOLDER, JSON.stringify(folder))
        } catch {
          /* fail soft */
        }
      }
      return
    }

    setActiveFolderState(folder)
    setState(buildInitialStateFor(nextFolderId))
    lastFolderIdRef.current = nextFolderId
    if (typeof window === "undefined") return
    try {
      if (folder) {
        window.localStorage.setItem(STORAGE_ACTIVE_FOLDER, JSON.stringify(folder))
      } else {
        window.localStorage.removeItem(STORAGE_ACTIVE_FOLDER)
      }
    } catch {
      /* fail soft */
    }
  }, [])

  // Persist on every change. Cheap because the tree is small and
  // localStorage writes are sync but very fast for sub-MB payloads.
  React.useEffect(() => {
    writePersisted(activeFolder?.id ?? null, state)
  }, [activeFolder?.id, state])

  const openFile = React.useCallback((path: string, content?: string) => {
    const cleaned = normalizePath(path)
    if (!cleaned) return
    setState((prev) => {
      const exists = Boolean(prev.files[cleaned])
      let files = prev.files
      if (!exists) {
        const file: CodeFile = {
          path: cleaned,
          language: languageForPath(cleaned),
          content: content ?? "",
          updatedAt: Date.now(),
        }
        files = { ...prev.files, [cleaned]: file }
      } else if (typeof content === "string" && content !== prev.files[cleaned].content) {
        files = {
          ...prev.files,
          [cleaned]: { ...prev.files[cleaned], content, updatedAt: Date.now() },
        }
      }
      const openTabs = prev.openTabs.includes(cleaned) ? prev.openTabs : [...prev.openTabs, cleaned]
      return { files, openTabs, activePath: cleaned }
    })
  }, [])

  const closeTab = React.useCallback((path: string) => {
    setState((prev) => {
      if (!prev.openTabs.includes(path)) return prev
      const openTabs = prev.openTabs.filter((p) => p !== path)
      let activePath = prev.activePath
      if (prev.activePath === path) {
        const idx = prev.openTabs.indexOf(path)
        activePath = openTabs[idx] ?? openTabs[idx - 1] ?? openTabs[0] ?? null
      }
      return { ...prev, openTabs, activePath }
    })
  }, [])

  const setActiveTab = React.useCallback((path: string) => {
    setState((prev) => {
      if (prev.activePath === path) return prev
      const openTabs = prev.openTabs.includes(path) ? prev.openTabs : [...prev.openTabs, path]
      return { ...prev, openTabs, activePath: path }
    })
  }, [])

  const updateFile = React.useCallback((path: string, content: string) => {
    let changed = false
    setState((prev) => {
      const existing = prev.files[path]
      if (!existing) return prev
      if (existing.content === content) return prev
      changed = true
      const files = { ...prev.files, [path]: { ...existing, content, updatedAt: Date.now() } }
      return { ...prev, files }
    })
    if (changed) mirrorWrite(activeFolderIdRef.current, path, content)
  }, [])

  const createFile = React.useCallback((path: string, content = "") => {
    const cleaned = normalizePath(path)
    if (!cleaned) return
    let isNew = false
    setState((prev) => {
      if (prev.files[cleaned]) {
        // Treat as "open the existing file" rather than overwriting.
        return {
          ...prev,
          openTabs: prev.openTabs.includes(cleaned) ? prev.openTabs : [...prev.openTabs, cleaned],
          activePath: cleaned,
        }
      }
      const file: CodeFile = {
        path: cleaned,
        language: languageForPath(cleaned),
        content,
        updatedAt: Date.now(),
      }
      isNew = true
      return {
        files: { ...prev.files, [cleaned]: file },
        openTabs: [...prev.openTabs, cleaned],
        activePath: cleaned,
      }
    })
    if (isNew) mirrorWrite(activeFolderIdRef.current, cleaned, content)
  }, [])

  const renameFile = React.useCallback((oldPath: string, newPath: string) => {
    const cleanedNew = normalizePath(newPath)
    if (!cleanedNew || cleanedNew === oldPath) return
    let didRename = false
    setState((prev) => {
      const file = prev.files[oldPath]
      if (!file) return prev
      if (prev.files[cleanedNew]) return prev // refuse to clobber
      didRename = true
      const renamed: CodeFile = {
        ...file,
        path: cleanedNew,
        language: languageForPath(cleanedNew),
        updatedAt: Date.now(),
      }
      const files = { ...prev.files, [cleanedNew]: renamed }
      delete files[oldPath]
      const openTabs = prev.openTabs.map((p) => (p === oldPath ? cleanedNew : p))
      const activePath = prev.activePath === oldPath ? cleanedNew : prev.activePath
      return { files, openTabs, activePath }
    })
    if (didRename) mirrorRename(activeFolderIdRef.current, oldPath, cleanedNew)
  }, [])

  const deleteFile = React.useCallback((path: string) => {
    let didDelete = false
    setState((prev) => {
      if (!prev.files[path]) return prev
      didDelete = true
      const files = { ...prev.files }
      delete files[path]
      const openTabs = prev.openTabs.filter((p) => p !== path)
      const activePath =
        prev.activePath === path ? openTabs[openTabs.length - 1] ?? null : prev.activePath
      return { files, openTabs, activePath }
    })
    if (didDelete) mirrorDelete(activeFolderIdRef.current, path)
  }, [])

  const resetWorkspace = React.useCallback(() => {
    const starter = defaultStarterFiles()
    const files: CodeFiles = {}
    for (const f of starter) files[f.path] = f
    setState({ files, openTabs: starter.slice(0, 2).map((f) => f.path), activePath: starter[0]?.path ?? null })
    setWorkspaceSource({ kind: "starter", name: "Ejemplo local", linked: false })
  }, [])

  const forgetWorkspace = React.useCallback(
    (id: string) => {
      if (!id) return
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(storageKeyFor(id))
        } catch {
          /* fail soft */
        }
      }
      // If the deleted workspace is the one currently open, drop back to the
      // starter project so the editor never points at a folder that's gone.
      if (activeFolder?.id === id) {
        setActiveFolder(null)
        resetWorkspace()
      }
    },
    [activeFolder?.id, setActiveFolder, resetWorkspace],
  )

  const openLocalFolderWorkspace = React.useCallback(async () => {
    try {
      // showDirectoryPicker (File System Access API) is blocked inside
      // cross-origin iframes (the Replit preview throws "Cross origin sub frames
      // aren't allowed to show a file picker.") and is unsupported in
      // Safari/Firefox. In those contexts read the folder via a classic
      // <input webkitdirectory> upload instead (read-only, not write-linked).
      let inIframe = true
      try {
        inIframe = typeof window !== "undefined" && window.self !== window.top
      } catch {
        inIframe = true
      }

      let imported: LocalWorkspaceImport | null
      let linked = false
      if (inIframe || !canOpenLocalDirectory()) {
        imported = await readLocalFolderViaInput()
        if (!imported) return // user cancelled the picker
      } else {
        try {
          imported = await openLocalDirectoryWorkspace()
          linked = true
        } catch (err) {
          const e = err as Error
          if (e?.name === "AbortError") return
          // A native picker blocked by cross-origin policy still lands here —
          // retry with the iframe-safe <input> upload before giving up.
          if (e?.name === "SecurityError" || /cross origin/i.test(String(e?.message || ""))) {
            imported = await readLocalFolderViaInput()
            if (!imported) return
          } else {
            throw e
          }
        }
      }

      const paths = pickInitialOpenTabs(Object.keys(imported.files))
      const codexId = codexIdForLocalFolder(imported.rootName)
      const nextState = {
        files: imported.files,
        openTabs: paths,
        activePath: paths[0] ?? Object.keys(imported.files)[0] ?? null,
      }
      setState(nextState)
      writePersisted(codexId, nextState)
      setActiveFolder({ id: codexId, name: imported.rootName })
      setWorkspaceSource({
        kind: "local-folder",
        name: imported.rootName,
        linked,
        fileCount: imported.fileCount,
        skippedCount: imported.skippedCount,
      })
      upsertCodexProject({
        id: codexId,
        name: imported.rootName,
        kind: "local-folder",
        displayPath: `~/Desktop/${imported.rootName}`,
        fileCount: imported.fileCount,
      })
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
      }
      toast.success(`Carpeta "${imported.rootName}" abierta como workspace.`)
      if (imported.fileCount === 0) {
        toast.info("La carpeta está vacía — crea archivos o pídeselos al agente para empezar.")
      }
      if (imported.skippedCount > 0) {
        toast.info(`${imported.skippedCount} archivo(s) se omitieron por tamaño, formato o carpeta ignorada.`)
      }
    } catch (error) {
      const err = error as Error
      if (err?.name === "AbortError") return
      toast.error(err?.message || "No se pudo abrir la carpeta local.")
    }
  }, [setActiveFolder])

  const switchCodexWorkspace = React.useCallback(
    async (target: { id: string; name: string; kind: "local-folder" | "project"; projectId?: string }) => {
      if (target.kind === "project") {
        const projectId = target.projectId || target.id.replace(/^project:/, "")
        try {
          const project = await projectsService.get(projectId)
          setActiveFolder({
            id: project.id,
            name: project.name,
            description: project.description,
            instructions: project.instructions,
          })
          upsertCodexProject({
            id: codexIdForProject(project.id),
            name: project.name,
            kind: "project",
          })
        } catch {
          setActiveFolder({ id: projectId, name: target.name })
        }
        setWorkspaceSource({ kind: "browser", name: target.name, linked: false })
        setActiveCodexProject(readWorkspaceCodexProject(projectId))
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
        }
        return
      }

      const persisted = buildInitialStateFor(target.id)
      setActiveFolder({ id: target.id, name: target.name })
      const linked = hasLinkedLocalFolder() && getLinkedLocalFolderName() === target.name
      setWorkspaceSource({
        kind: linked ? "local-folder" : "browser",
        name: target.name,
        linked,
        fileCount: Object.keys(persisted.files).length,
      })
      upsertCodexProject({
        id: target.id,
        name: target.name,
        kind: "local-folder",
        fileCount: Object.keys(persisted.files).length,
      })
      setActiveCodexProject(readWorkspaceCodexProject(target.id))
      if (!linked && Object.keys(persisted.files).length === 0) {
        toast.info("Vuelve a enlazar la carpeta con + si quieres sincronizar con el disco.")
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
      }
    },
    [setActiveFolder],
  )

  React.useEffect(() => {
    const openFolder = () => {
      void openLocalFolderWorkspace()
    }
    const switchWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<{
        id: string
        name: string
        kind: "local-folder" | "project"
        projectId?: string
      }>).detail
      if (!detail?.id) return
      void switchCodexWorkspace(detail)
    }
    const forget = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail
      if (!detail?.id) return
      forgetWorkspace(detail.id)
    }
    window.addEventListener("siragpt:open-local-folder", openFolder)
    window.addEventListener(SWITCH_CODEX_WORKSPACE_EVENT, switchWorkspace)
    window.addEventListener(FORGET_CODEX_WORKSPACE_EVENT, forget)
    return () => {
      window.removeEventListener("siragpt:open-local-folder", openFolder)
      window.removeEventListener(SWITCH_CODEX_WORKSPACE_EVENT, switchWorkspace)
      window.removeEventListener(FORGET_CODEX_WORKSPACE_EVENT, forget)
    }
  }, [openLocalFolderWorkspace, switchCodexWorkspace, forgetWorkspace])

  const saveFileToWorkspace = React.useCallback(async (path?: string) => {
    const targetPath = path || state.activePath
    if (!targetPath) return false
    const file = state.files[targetPath]
    if (!file) return false

    if (workspaceSource.kind !== "local-folder" || !hasLinkedLocalFolder()) {
      toast.success("Guardado en el workspace del navegador.")
      return true
    }

    try {
      await saveLinkedWorkspaceFile(file.path, file.content)
      const folderName = getLinkedLocalFolderName() || workspaceSource.name
      toast.success(`${file.path} guardado en ${folderName}.`)
      return true
    } catch (error) {
      toast.error((error as Error)?.message || "No se pudo guardar en la carpeta local.")
      return false
    }
  }, [state.activePath, state.files, workspaceSource.kind, workspaceSource.name])

  const applyBlock = React.useCallback((path: string, content: string) => {
    const cleaned = normalizePath(path)
    if (!cleaned) return ""
    setState((prev) => {
      const existing = prev.files[cleaned]
      const file: CodeFile = existing
        ? { ...existing, content, updatedAt: Date.now() }
        : {
            path: cleaned,
            language: languageForPath(cleaned),
            content,
            updatedAt: Date.now(),
          }
      const files = { ...prev.files, [cleaned]: file }
      const openTabs = prev.openTabs.includes(cleaned) ? prev.openTabs : [...prev.openTabs, cleaned]
      return { files, openTabs, activePath: cleaned }
    })
    // Mirror the agent's write to the bound GitHub clone (if any) so its
    // edits land in the real, committable/pushable/downloadable repo.
    mirrorWrite(activeFolderIdRef.current, cleaned, content)
    // Surface the live preview as soon as the agent writes code, so the
    // "instruct → build → see it" loop closes without a manual toggle.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
    }
    return cleaned
  }, [])

  // Bulk-load files into the workspace (e.g. from a bound GitHub repo) WITHOUT
  // mirroring back to the clone — the clone is the source here.
  const hydrateFiles = React.useCallback((incoming: { path: string; content: string }[]) => {
    const folderId = activeFolderIdRef.current
    setMirrorSuppressed(folderId, true)
    setState((prev) => {
      const files: CodeFiles = {}
      for (const f of incoming) {
        const cleaned = normalizePath(f.path)
        if (!cleaned) continue
        files[cleaned] = {
          path: cleaned,
          language: languageForPath(cleaned),
          content: f.content,
          updatedAt: Date.now(),
        }
      }
      const firstPath = Object.keys(files)[0] ?? null
      const keepActive = prev.activePath && files[prev.activePath] ? prev.activePath : firstPath
      const openTabs = prev.openTabs.filter((p) => files[p])
      return { files, openTabs: keepActive && !openTabs.includes(keepActive) ? [...openTabs, keepActive] : openTabs, activePath: keepActive }
    })
    // Let the suppression cover this render's persistence cycle, then re-enable.
    if (typeof window !== "undefined") {
      window.setTimeout(() => setMirrorSuppressed(folderId, false), 0)
    } else {
      setMirrorSuppressed(folderId, false)
    }
  }, [])

  const registerChatFocusHandler = React.useCallback((handler: ChatFocusListener) => {
    chatFocusListeners.current.add(handler)
    return () => {
      chatFocusListeners.current.delete(handler)
    }
  }, [])

  const focusChat = React.useCallback(() => {
    chatFocusListeners.current.forEach((handler) => {
      try { handler() } catch { /* ignore */ }
    })
  }, [])

  const registerCommandPaletteHandler = React.useCallback((handler: CommandPaletteListener) => {
    paletteListeners.current.add(handler)
    return () => {
      paletteListeners.current.delete(handler)
    }
  }, [])

  const openCommandPalette = React.useCallback(() => {
    paletteListeners.current.forEach((handler) => {
      try { handler() } catch { /* ignore */ }
    })
  }, [])

  const codeChatSessions = React.useMemo(
    () => listSessionsForWorkspace(workspaceSessionKey, chatSessionStore),
    [workspaceSessionKey, chatSessionStore],
  )

  const activeCodeChatSessionId = React.useMemo(
    () => getActiveSessionId(workspaceSessionKey, chatSessionStore),
    [workspaceSessionKey, chatSessionStore],
  )

  const activeCodeChatSession = React.useMemo(
    () => codeChatSessions.find((s) => s.id === activeCodeChatSessionId) ?? null,
    [codeChatSessions, activeCodeChatSessionId],
  )

  const listCodeChatSessionsForWorkspace = React.useCallback(
    (workspaceId: string) => listSessionsForWorkspace(codexWorkspaceSessionKey(workspaceId), chatSessionStore),
    [chatSessionStore],
  )

  const createCodeChatSession = React.useCallback((opts?: { title?: string }) => {
    const sessionId = createCodeChatSessionId()
    setChatSessionStore((prev) =>
      createCodeChatSessionRecord(workspaceSessionKey, { ...opts, id: sessionId }, prev).store,
    )
    focusChat()
    return sessionId
  }, [focusChat, workspaceSessionKey])

  const setActiveCodeChatSession = React.useCallback(
    (sessionId: string) => {
      // Functional updater: never read the store from the closure — back-to-back
      // store mutations in one tick must each see the previous result, or they
      // clobber each other (e.g. setTurns + patchAgentState in the same dispatch).
      setChatSessionStore((prev) => setActiveCodeChatSessionRecord(workspaceSessionKey, sessionId, prev))
      focusChat()
    },
    [focusChat, workspaceSessionKey],
  )

  const patchCodeChatSessionTurns = React.useCallback(
    (sessionId: string, updater: (prev: CodeChatTurn[]) => CodeChatTurn[]) => {
      setChatSessionStore((prev) => updateCodeChatSessionTurns(sessionId, updater, prev))
    },
    [],
  )

  const patchAgentState = React.useCallback(
    (sessionId: string, updater: (prev: AgentState) => AgentState) => {
      setChatSessionStore((prev) => updateCodeChatSessionAgent(sessionId, updater, prev))
    },
    [],
  )

  const openWorkspaceNewCodeChat = React.useCallback(
    async (detail: CodeNewChatDetail) => {
      await switchCodexWorkspace({
        id: detail.workspaceId,
        name: detail.name,
        kind: detail.kind,
        projectId: detail.projectId,
      })
      const key = codexWorkspaceSessionKey(detail.workspaceId)
      const existing = detail.title
        ? listSessionsForWorkspace(key, chatSessionStore).find((session) => session.title === detail.title)
        : null
      if (existing) {
        setChatSessionStore(setActiveCodeChatSessionRecord(key, existing.id, chatSessionStore))
      } else {
        const { store } = createCodeChatSessionRecord(
          key,
          detail.title ? { title: detail.title } : undefined,
          chatSessionStore,
        )
        setChatSessionStore(store)
      }
      focusChat()
    },
    [chatSessionStore, focusChat, switchCodexWorkspace],
  )

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onNewChat = (event: Event) => {
      const detail = (event as CustomEvent<CodeNewChatDetail>).detail
      if (!detail?.workspaceId) return
      void openWorkspaceNewCodeChat(detail)
    }
    const onSelectSession = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; sessionId: string }>).detail
      if (!detail?.sessionId || !detail.workspaceId) return
      const targetKey = codexWorkspaceSessionKey(detail.workspaceId)
      void (async () => {
        if (targetKey !== workspaceSessionKey) {
          const entry = listCodexProjects().find((row) => row.id === detail.workspaceId)
          if (entry) {
            await switchCodexWorkspace({
              id: entry.id,
              name: entry.name,
              kind: entry.kind,
              projectId: entry.kind === "project" ? entry.id.replace(/^project:/, "") : undefined,
            })
          }
        }
        setChatSessionStore((prev) =>
          setActiveCodeChatSessionRecord(targetKey, detail.sessionId, prev),
        )
        focusChat()
      })()
    }
    window.addEventListener(CODE_NEW_CODE_CHAT_EVENT, onNewChat)
    window.addEventListener(CODE_SELECT_CHAT_SESSION_EVENT, onSelectSession)
    return () => {
      window.removeEventListener(CODE_NEW_CODE_CHAT_EVENT, onNewChat)
      window.removeEventListener(CODE_SELECT_CHAT_SESSION_EVENT, onSelectSession)
    }
  }, [activeFolder?.id, chatSessionStore, focusChat, openWorkspaceNewCodeChat, switchCodexWorkspace, workspaceSessionKey])

  const value = React.useMemo<CodeWorkspaceContextValue>(
    () => ({
      files: state.files,
      openTabs: state.openTabs,
      activePath: state.activePath,
      openFile,
      closeTab,
      setActiveTab,
      updateFile,
      createFile,
      renameFile,
      deleteFile,
      resetWorkspace,
      forgetWorkspace,
      openLocalFolderWorkspace,
      saveFileToWorkspace,
      applyBlock,
      hydrateFiles,
      registerChatFocusHandler,
      focusChat,
      registerCommandPaletteHandler,
      openCommandPalette,
      activeFolder,
      setActiveFolder,
      workspaceSource,
      switchCodexWorkspace,
      codeChatSessions,
      activeCodeChatSessionId,
      activeCodeChatSession,
      createCodeChatSession,
      setActiveCodeChatSession,
      patchCodeChatSessionTurns,
      patchAgentState,
      listCodeChatSessionsForWorkspace,
      openWorkspaceNewCodeChat,
    }),
    [
      state.files,
      state.openTabs,
      state.activePath,
      openFile,
      closeTab,
      setActiveTab,
      updateFile,
      createFile,
      renameFile,
      deleteFile,
      resetWorkspace,
      forgetWorkspace,
      openLocalFolderWorkspace,
      saveFileToWorkspace,
      applyBlock,
      hydrateFiles,
      registerChatFocusHandler,
      focusChat,
      registerCommandPaletteHandler,
      openCommandPalette,
      activeFolder,
      setActiveFolder,
      workspaceSource,
      switchCodexWorkspace,
      codeChatSessions,
      activeCodeChatSessionId,
      activeCodeChatSession,
      createCodeChatSession,
      setActiveCodeChatSession,
      patchCodeChatSessionTurns,
      patchAgentState,
      listCodeChatSessionsForWorkspace,
      openWorkspaceNewCodeChat,
    ],
  )

  return <CodeWorkspaceContext.Provider value={value}>{children}</CodeWorkspaceContext.Provider>
}

export function useCodeWorkspace(): CodeWorkspaceContextValue {
  const ctx = React.useContext(CodeWorkspaceContext)
  if (!ctx) {
    throw new Error("useCodeWorkspace must be used within a CodeWorkspaceProvider")
  }
  return ctx
}

export function useOptionalCodeWorkspace(): CodeWorkspaceContextValue | null {
  return React.useContext(CodeWorkspaceContext)
}

function isLowSignalWorkspacePath(path: string): boolean {
  const p = path.toLowerCase()
  if (p.includes(".orchestration/")) return true
  if (/\/agent-\d+/.test(p)) return true
  if (p.includes("/locales/") && p.endsWith(".json")) return true
  if (p.endsWith(".report.md") && p.includes("agent-")) return true
  if (p.endsWith(".prompt.md") && p.includes("agent-")) return true
  return false
}

function pickInitialOpenTabs(paths: string[]): string[] {
  const sorted = [...paths].filter((p) => !isLowSignalWorkspacePath(p)).sort((a, b) => a.localeCompare(b))
  const preferred = [
    "README.md",
    "readme.md",
    "package.json",
    "index.html",
    "src/app.tsx",
    "app/page.tsx",
  ]
  const picked: string[] = []
  for (const path of preferred) {
    const found = sorted.find((candidate) => candidate.toLowerCase() === path.toLowerCase())
    if (found && !picked.includes(found)) picked.push(found)
  }
  for (const path of sorted) {
    if (picked.length >= 3) break
    if (!picked.includes(path)) picked.push(path)
  }
  return picked
}
