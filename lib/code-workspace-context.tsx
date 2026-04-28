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
  getLinkedLocalFolderName,
  hasLinkedLocalFolder,
  openLocalDirectoryWorkspace,
  saveLinkedWorkspaceFile,
} from "./local-folder-workspace"

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
  workspaceSource: WorkspaceSource
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

  const starter = defaultStarterFiles()
  const files: CodeFiles = {}
  for (const f of starter) files[f.path] = f
  const openTabs = starter.slice(0, 2).map((f) => f.path)
  const activePath = openTabs[0] ?? null
  return { files, openTabs, activePath }
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
    setState((prev) => {
      const existing = prev.files[path]
      if (!existing) return prev
      if (existing.content === content) return prev
      const files = { ...prev.files, [path]: { ...existing, content, updatedAt: Date.now() } }
      return { ...prev, files }
    })
  }, [])

  const createFile = React.useCallback((path: string, content = "") => {
    const cleaned = normalizePath(path)
    if (!cleaned) return
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
      return {
        files: { ...prev.files, [cleaned]: file },
        openTabs: [...prev.openTabs, cleaned],
        activePath: cleaned,
      }
    })
  }, [])

  const renameFile = React.useCallback((oldPath: string, newPath: string) => {
    const cleanedNew = normalizePath(newPath)
    if (!cleanedNew || cleanedNew === oldPath) return
    setState((prev) => {
      const file = prev.files[oldPath]
      if (!file) return prev
      if (prev.files[cleanedNew]) return prev // refuse to clobber
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
  }, [])

  const deleteFile = React.useCallback((path: string) => {
    setState((prev) => {
      if (!prev.files[path]) return prev
      const files = { ...prev.files }
      delete files[path]
      const openTabs = prev.openTabs.filter((p) => p !== path)
      const activePath =
        prev.activePath === path ? openTabs[openTabs.length - 1] ?? null : prev.activePath
      return { files, openTabs, activePath }
    })
  }, [])

  const resetWorkspace = React.useCallback(() => {
    const starter = defaultStarterFiles()
    const files: CodeFiles = {}
    for (const f of starter) files[f.path] = f
    setState({ files, openTabs: starter.slice(0, 2).map((f) => f.path), activePath: starter[0]?.path ?? null })
    setWorkspaceSource({ kind: "starter", name: "Ejemplo local", linked: false })
  }, [])

  const openLocalFolderWorkspace = React.useCallback(async () => {
    try {
      const imported = await openLocalDirectoryWorkspace()
      const paths = pickInitialOpenTabs(Object.keys(imported.files))
      setState({
        files: imported.files,
        openTabs: paths,
        activePath: paths[0] ?? Object.keys(imported.files)[0] ?? null,
      })
      setWorkspaceSource({
        kind: "local-folder",
        name: imported.rootName,
        linked: true,
        fileCount: imported.fileCount,
        skippedCount: imported.skippedCount,
      })
      toast.success(`Carpeta "${imported.rootName}" abierta como workspace.`)
      if (imported.skippedCount > 0) {
        toast.info(`${imported.skippedCount} archivo(s) se omitieron por tamaño, formato o carpeta ignorada.`)
      }
    } catch (error) {
      const err = error as Error
      if (err?.name === "AbortError") return
      toast.error(err?.message || "No se pudo abrir la carpeta local.")
    }
  }, [])

  React.useEffect(() => {
    const handler = () => {
      void openLocalFolderWorkspace()
    }
    window.addEventListener("siragpt:open-local-folder", handler)
    return () => window.removeEventListener("siragpt:open-local-folder", handler)
  }, [openLocalFolderWorkspace])

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
    return cleaned
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
      openLocalFolderWorkspace,
      saveFileToWorkspace,
      applyBlock,
      registerChatFocusHandler,
      focusChat,
      registerCommandPaletteHandler,
      openCommandPalette,
      activeFolder,
      setActiveFolder,
      workspaceSource,
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
      openLocalFolderWorkspace,
      saveFileToWorkspace,
      applyBlock,
      registerChatFocusHandler,
      focusChat,
      registerCommandPaletteHandler,
      openCommandPalette,
      activeFolder,
      setActiveFolder,
      workspaceSource,
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

function pickInitialOpenTabs(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b))
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
