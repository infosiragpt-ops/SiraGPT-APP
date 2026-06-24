"use client"

/**
 * SidebarFoldersDropdown — Codex workspaces block in the app sidebar.
 */

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Cloud,
  FolderOpen,
  FolderPlus,
  Github,
  Globe,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CodexFolderPicker } from "@/components/codex/codex-folder-picker"
import { CodexWorkspaceTree, type ChatRow, type WorkspaceTreeNode } from "@/components/codex/codex-workspace-tree"
import {
  CODE_CHAT_SESSIONS_UPDATED_EVENT,
  codexWorkspaceSessionKey,
  deleteCodeChatSession,
  getActiveSessionId,
  listSessionsForWorkspace,
  readCodeChatStore,
  renameCodeChatSession,
} from "@/lib/code-chat-sessions"
import {
  CODE_NEW_CODE_CHAT_EVENT,
  CODE_SELECT_CHAT_SESSION_EVENT,
  FORGET_CODEX_WORKSPACE_EVENT,
  type CodeNewChatDetail,
} from "@/lib/code-workspace-context"
import { useChat } from "@/lib/chat-context-integrated"
import {
  CODEX_UPDATED_EVENT,
  codexIdForProject,
  listCodexProjects,
  removeCodexProject,
  type CodexProjectEntry,
  upsertCodexProject,
} from "@/lib/codex-projects"
import {
  CODEX_PREFS_UPDATED_EVENT,
  forgetRow,
  getArchivedRows,
  getDisplayOptions,
  getPinnedRows,
  getReadRows,
  markRowRead,
  markRowUnread,
  setDisplayOption,
  toggleArchivedRow,
  togglePinnedRow,
  type CodexDisplayOptions,
} from "@/lib/codex-conversation-prefs"
import { canOpenLocalDirectory, importLocalFolderAsWorkspace } from "@/lib/local-folder-workspace"
import { apiClient } from "@/lib/api"
import {
  projectsService,
  type Project,
  type ProjectChatSummary,
  type ProjectHostingProvider,
  type ProjectType,
} from "@/lib/projects-service"
import { normalizeChatInput } from "@/lib/chat-input-normalize"
import { cn } from "@/lib/utils"

const STORAGE_EXPANDED = "code-workspace:expanded-workspaces"
const STORAGE_ACTIVE_FOLDER = "code-workspace:active-folder"
// Prefix of the per-workspace files/tabs bucket the /code provider persists
// (storageKeyFor → `code-workspace:v1:<id>`). Cleared when a workspace is deleted.
const WORKSPACE_STATE_PREFIX = "code-workspace:v1"

type Props = {
  collapsed: boolean
  onMobileNavigate?: () => void
}

export function SidebarFoldersDropdown({ collapsed, onMobileNavigate }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const isOnCodePage = pathname?.startsWith("/code") ?? false
  const { selectChat, currentChat } = useChat()

  const [folders, setFolders] = React.useState<Project[]>([])
  const [codexProjects, setCodexProjects] = React.useState<CodexProjectEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // "Proyecto en la nube" modal — replaces the native window.prompt.
  const [cloudDialogOpen, setCloudDialogOpen] = React.useState(false)
  const [cloudName, setCloudName] = React.useState("")
  const [creatingCloud, setCreatingCloud] = React.useState(false)
  // New-project choices: kind (general vs web app) + where it's hosted.
  // GitHub hosting is a placeholder until the OAuth/push flow ships.
  const [cloudType, setCloudType] = React.useState<ProjectType>("general")
  const [cloudHosting, setCloudHosting] = React.useState<ProjectHostingProvider>("sira-cloud")

  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [chatsByFolder, setChatsByFolder] = React.useState<
    Record<string, { loading: boolean; chats: ProjectChatSummary[]; error: string | null }>
  >({})
  const [activeFolderId, setActiveFolderId] = React.useState<string | null>(null)
  const [codeAgentStore, setCodeAgentStore] = React.useState(readCodeChatStore)

  const [displayOptions, setDisplayOptions] = React.useState<CodexDisplayOptions>(getDisplayOptions)
  const [pinnedRows, setPinnedRows] = React.useState<Set<string>>(() => new Set())
  const [archivedRows, setArchivedRows] = React.useState<Set<string>>(() => new Set())
  const [readRows, setReadRows] = React.useState<Set<string>>(() => new Set())

  const syncPrefs = React.useCallback(() => {
    setDisplayOptions(getDisplayOptions())
    setPinnedRows(getPinnedRows())
    setArchivedRows(getArchivedRows())
    setReadRows(getReadRows())
  }, [])

  React.useEffect(() => {
    syncPrefs()
    window.addEventListener(CODEX_PREFS_UPDATED_EVENT, syncPrefs)
    return () => window.removeEventListener(CODEX_PREFS_UPDATED_EVENT, syncPrefs)
  }, [syncPrefs])

  const refreshCodexProjects = React.useCallback(() => {
    setCodexProjects(listCodexProjects())
  }, [])

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_EXPANDED)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) setExpandedIds(new Set(arr.filter((v) => typeof v === "string")))
      }
      const activeRaw = window.localStorage.getItem(STORAGE_ACTIVE_FOLDER)
      if (activeRaw) {
        try {
          const parsed = JSON.parse(activeRaw) as { id?: string }
          if (parsed?.id) setActiveFolderId(parsed.id)
        } catch {
          setActiveFolderId(activeRaw)
        }
      }
    } catch {
      /* ignore */
    }
    refreshCodexProjects()
  }, [refreshCodexProjects])

  React.useEffect(() => {
    const handler = () => refreshCodexProjects()
    window.addEventListener(CODEX_UPDATED_EVENT, handler)
    return () => window.removeEventListener(CODEX_UPDATED_EVENT, handler)
  }, [refreshCodexProjects])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const sync = () => setCodeAgentStore(readCodeChatStore())
    window.addEventListener(CODE_CHAT_SESSIONS_UPDATED_EVENT, sync)
    const onFolderChange = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_ACTIVE_FOLDER)
        if (!raw) return
        const parsed = JSON.parse(raw) as { id?: string }
        if (parsed?.id) setActiveFolderId(parsed.id)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener(CODEX_UPDATED_EVENT, onFolderChange)
    return () => {
      window.removeEventListener(CODE_CHAT_SESSIONS_UPDATED_EVENT, sync)
      window.removeEventListener(CODEX_UPDATED_EVENT, onFolderChange)
    }
  }, [])

  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_EXPANDED, JSON.stringify(Array.from(expandedIds)))
    } catch {
      /* fail soft */
    }
  }, [expandedIds])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await projectsService.list({ sort: "activity" })
      setFolders(list)
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los workspaces")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const localProjects = React.useMemo(
    () => codexProjects.filter((row) => row.kind === "local-folder"),
    [codexProjects],
  )

  const workspaceNodes = React.useMemo<WorkspaceTreeNode[]>(() => {
    const locals: WorkspaceTreeNode[] = localProjects.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: "local-folder",
      chatListId: entry.id,
    }))
    const cloud: WorkspaceTreeNode[] = folders.map((folder) => ({
      id: codexIdForProject(folder.id),
      name: folder.name,
      kind: "project",
      chatListId: folder.id,
    }))
    return [...locals, ...cloud]
  }, [folders, localProjects])

  const activeWorkspaceId = React.useMemo(() => {
    if (!activeFolderId) return null
    const key = codexWorkspaceSessionKey(activeFolderId)
    if (workspaceNodes.some((n) => n.id === key)) return key
    if (localProjects.some((l) => l.id === activeFolderId)) return activeFolderId
    if (folders.some((f) => f.id === activeFolderId)) return codexIdForProject(activeFolderId)
    return key
  }, [activeFolderId, folders, localProjects, workspaceNodes])

  const activeCodeSessionId = React.useMemo(() => {
    if (!activeWorkspaceId) return null
    return getActiveSessionId(activeWorkspaceId, codeAgentStore)
  }, [activeWorkspaceId, codeAgentStore])

  const toggleExpanded = React.useCallback((workspaceId: string) => {
    const node = workspaceNodes.find((n) => n.id === workspaceId)
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
    if (node?.kind === "project") {
      setChatsByFolder((prev) => {
        if (prev[node.chatListId]?.chats?.length || prev[node.chatListId]?.loading) return prev
        return { ...prev, [node.chatListId]: { loading: true, chats: [], error: null } }
      })
    }
  }, [workspaceNodes])

  React.useEffect(() => {
    const pending = workspaceNodes.find(
      (n) =>
        n.kind === "project"
        && expandedIds.has(n.id)
        && chatsByFolder[n.chatListId]?.loading
        && !chatsByFolder[n.chatListId]?.chats?.length,
    )
    if (!pending) return
    let cancelled = false
    ;(async () => {
      try {
        const chats = await projectsService.listChats(pending.chatListId, { limit: 12 })
        if (cancelled) return
        setChatsByFolder((prev) => ({
          ...prev,
          [pending.chatListId]: { loading: false, chats, error: null },
        }))
      } catch (err: any) {
        if (cancelled) return
        setChatsByFolder((prev) => ({
          ...prev,
          [pending.chatListId]: {
            loading: false,
            chats: [],
            error: err?.message || "No se pudieron cargar los chats",
          },
        }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [expandedIds, chatsByFolder, workspaceNodes])

  const handleOpenInCode = React.useCallback(
    (opts: { folderId?: string; localId?: string }) => {
      if (opts.folderId) {
        const codexId = codexIdForProject(opts.folderId)
        const folder = folders.find((f) => f.id === opts.folderId)
        try {
          window.localStorage.setItem(
            STORAGE_ACTIVE_FOLDER,
            JSON.stringify({ id: codexId, name: folder?.name || opts.folderId }),
          )
        } catch {
          /* ignore */
        }
        setActiveFolderId(codexId)
      }
      if (opts.localId) {
        const entry = localProjects.find((l) => l.id === opts.localId)
        try {
          window.localStorage.setItem(
            STORAGE_ACTIVE_FOLDER,
            JSON.stringify({ id: opts.localId, name: entry?.name || opts.localId }),
          )
        } catch {
          /* ignore */
        }
        setActiveFolderId(opts.localId)
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("siragpt:collapse-sidebar"))
      }
      const params = new URLSearchParams()
      if (opts.folderId) params.set("folder", opts.folderId)
      if (opts.localId) params.set("local", opts.localId)
      const query = params.toString()
      const target = query ? `/code?${query}` : "/code"
      router.push(target)
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          if (!window.location.pathname.startsWith("/code")) {
            window.location.assign(target)
          }
        }, 450)
      }
      onMobileNavigate?.()
    },
    [folders, localProjects, onMobileNavigate, router],
  )

  const handleOpenWorkspace = React.useCallback(
    (node: WorkspaceTreeNode) => {
      if (node.kind === "project") {
        const projectId = node.chatListId
        try {
          window.localStorage.setItem(
            STORAGE_ACTIVE_FOLDER,
            JSON.stringify({ id: node.id, name: node.name }),
          )
        } catch {
          /* ignore */
        }
        setActiveFolderId(projectId)
        upsertCodexProject({ id: node.id, name: node.name, kind: "project" })
        refreshCodexProjects()
        window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
        handleOpenInCode({ folderId: projectId })
        return
      }
      handleOpenInCode({ localId: node.id })
    },
    [handleOpenInCode, refreshCodexProjects],
  )

  const handleDeleteWorkspace = React.useCallback(
    async (node: WorkspaceTreeNode) => {
      const isCloud = node.kind === "project"
      const message = isCloud
        ? `¿Eliminar el proyecto "${node.name}"? Se borrarán también sus archivos y chats. Esta acción no se puede deshacer.`
        : `¿Quitar la carpeta "${node.name}" de tus proyectos? Se elimina del panel y se borra su contenido en el navegador (no se toca ningún archivo de tu disco).`
      if (typeof window !== "undefined" && !window.confirm(message)) return
      try {
        if (isCloud) {
          await projectsService.remove(node.chatListId)
        }
        // Drop the registry entry + the persisted files/folders bucket, and tell
        // an open /code workspace to forget it (resetting the editor if active).
        removeCodexProject(node.id)
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(`${WORKSPACE_STATE_PREFIX}:${node.id}`)
          } catch {
            /* fail soft */
          }
          window.dispatchEvent(
            new CustomEvent(FORGET_CODEX_WORKSPACE_EVENT, { detail: { id: node.id } }),
          )
        }
        setChatsByFolder((prev) => {
          if (!(node.chatListId in prev)) return prev
          const next = { ...prev }
          delete next[node.chatListId]
          return next
        })
        refreshCodexProjects()
        if (isCloud) await refresh()
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
        }
        toast.success(isCloud ? `Proyecto "${node.name}" eliminado.` : `Carpeta "${node.name}" quitada.`)
      } catch (err: any) {
        toast.error(err?.message || "No se pudo eliminar el proyecto")
      }
    },
    [refresh, refreshCodexProjects],
  )

  const handleOpenChat = React.useCallback(
    (chatId: string) => {
      selectChat(chatId)
      router.push(`/chat?id=${encodeURIComponent(chatId)}`)
      onMobileNavigate?.()
    },
    [onMobileNavigate, router, selectChat],
  )

  const handleOpenDesktopFolder = React.useCallback(() => {
    if (typeof window === "undefined") return
    handleOpenInCode({})
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("siragpt:open-local-folder"))
    }, 120)
    onMobileNavigate?.()
  }, [handleOpenInCode, onMobileNavigate])

  const listCodeSessions = React.useCallback(
    (workspaceId: string) =>
      listSessionsForWorkspace(workspaceId, codeAgentStore).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    [codeAgentStore],
  )

  const handleSelectCodeSession = React.useCallback(
    (workspaceId: string, sessionId: string) => {
      const node = workspaceNodes.find((n) => n.id === workspaceId)
      if (!node) return
      handleOpenWorkspace(node)
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(CODE_SELECT_CHAT_SESSION_EVENT, {
              detail: { workspaceId, sessionId },
            }),
          )
        }, 180)
      }
    },
    [handleOpenWorkspace, workspaceNodes],
  )

  const handleNewCodeChat = React.useCallback(
    (node: WorkspaceTreeNode) => {
      handleOpenWorkspace(node)
      const detail: CodeNewChatDetail = {
        workspaceId: node.id,
        name: node.name,
        kind: node.kind,
        projectId: node.kind === "project" ? node.chatListId : undefined,
      }
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CODE_NEW_CODE_CHAT_EVENT, { detail }))
        }, 180)
      }
    },
    [handleOpenWorkspace],
  )

  const chatListIdForWorkspace = React.useCallback(
    (workspaceId: string) => workspaceNodes.find((n) => n.id === workspaceId)?.chatListId ?? null,
    [workspaceNodes],
  )

  const refetchFolderChats = React.useCallback(async (chatListId: string) => {
    setChatsByFolder((prev) => ({
      ...prev,
      [chatListId]: { loading: true, chats: prev[chatListId]?.chats ?? [], error: null },
    }))
    try {
      const chats = await projectsService.listChats(chatListId, { limit: 12 })
      setChatsByFolder((prev) => ({ ...prev, [chatListId]: { loading: false, chats, error: null } }))
    } catch (err: any) {
      setChatsByFolder((prev) => ({
        ...prev,
        [chatListId]: { loading: false, chats: prev[chatListId]?.chats ?? [], error: err?.message || "Error" },
      }))
    }
  }, [])

  const handleRenameRow = React.useCallback(
    async (row: ChatRow, title: string) => {
      if (row.source === "code") {
        renameCodeChatSession(row.id, title)
        setCodeAgentStore(readCodeChatStore())
        return
      }
      try {
        await apiClient.updateChat(row.id, { title })
        const chatListId = chatListIdForWorkspace(row.workspaceId)
        if (chatListId) await refetchFolderChats(chatListId)
      } catch (err: any) {
        toast.error(err?.message || "No se pudo renombrar la conversación")
      }
    },
    [chatListIdForWorkspace, refetchFolderChats],
  )

  const handleDeleteRow = React.useCallback(
    async (row: ChatRow) => {
      if (typeof window !== "undefined" && !window.confirm("¿Eliminar esta conversación?")) return
      if (row.source === "code") {
        deleteCodeChatSession(row.id)
        setCodeAgentStore(readCodeChatStore())
        forgetRow(row.key)
        return
      }
      try {
        await apiClient.deleteChat(row.id)
        forgetRow(row.key)
        const chatListId = chatListIdForWorkspace(row.workspaceId)
        if (chatListId) await refetchFolderChats(chatListId)
        toast.success("Conversación eliminada")
      } catch (err: any) {
        toast.error(err?.message || "No se pudo eliminar la conversación")
      }
    },
    [chatListIdForWorkspace, refetchFolderChats],
  )

  const handleMarkRead = React.useCallback((row: ChatRow) => { markRowRead(row.key) }, [])
  const handleMarkUnread = React.useCallback((row: ChatRow) => { markRowUnread(row.key) }, [])
  const handleTogglePin = React.useCallback((row: ChatRow) => { togglePinnedRow(row.key) }, [])
  const handleToggleArchive = React.useCallback((row: ChatRow) => {
    const set = toggleArchivedRow(row.key)
    toast(set.has(row.key) ? "Conversación archivada" : "Conversación restaurada")
  }, [])

  const handleOpenSettings = React.useCallback(
    (node: WorkspaceTreeNode) => { handleOpenWorkspace(node) },
    [handleOpenWorkspace],
  )

  // "Nuevo proyecto" → pick a local code folder. Opens showDirectoryPicker
  // directly in the click gesture (navigating first would drop user-activation
  // and the browser would block the picker), then routes into /code.
  const handleOpenLocalProject = React.useCallback(async () => {
    if (!canOpenLocalDirectory()) {
      // Safari/Firefox lack the File System Access API — fall back to the
      // /code in-app flow.
      handleOpenDesktopFolder()
      return
    }
    try {
      const reg = await importLocalFolderAsWorkspace()
      setActiveFolderId(reg.codexId)
      refreshCodexProjects()
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("siragpt:collapse-sidebar"))
      }
      router.push(`/code?local=${encodeURIComponent(reg.codexId)}`)
      onMobileNavigate?.()
      toast.success(`Carpeta "${reg.name}" abierta · ${reg.fileCount} archivos`)
      if (reg.skippedCount > 0) {
        toast.info(`${reg.skippedCount} archivo(s) omitidos por tamaño o formato`)
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return
      toast.error(err?.message || "No se pudo abrir la carpeta local")
    }
  }, [handleOpenDesktopFolder, onMobileNavigate, refreshCodexProjects, router])

  // Secondary entry: a cloud-only project (no local files). Opens a
  // styled modal instead of the native window.prompt.
  const handleNewCloudProject = React.useCallback(() => {
    setCloudName("")
    setCreatingCloud(false)
    setCloudType("general")
    setCloudHosting("sira-cloud")
    setCloudDialogOpen(true)
  }, [])

  // Empty on open; validated live. We normalise the same way the backend
  // stores it (strips invisible chars/BOM) so the button only lights up for
  // a name that will actually persist cleanly.
  const cloudNameClean = normalizeChatInput(cloudName).value.trim()
  // Soft, NON-blocking warning only: the backend (projects model has no
  // unique constraint on name) accepts duplicates, so we surface the
  // collision but never hard-block a valid create.
  const cloudNameDuplicate = React.useMemo(
    () =>
      cloudNameClean.length > 0 &&
      folders.some((f) => f.name.trim().toLowerCase() === cloudNameClean.toLowerCase()),
    [cloudNameClean, folders],
  )
  // GitHub hosting isn't available yet — selecting it disables submit and
  // shows a "coming soon" note instead of creating an orphaned project.
  const githubSelected = cloudHosting === "github"
  const canSubmitCloud = cloudNameClean.length > 0 && !creatingCloud && !githubSelected

  const submitCloudProject = React.useCallback(async () => {
    const clean = normalizeChatInput(cloudName).value.trim()
    if (!clean || creatingCloud || cloudHosting === "github") return
    setCreatingCloud(true)
    try {
      const project = await projectsService.create({
        name: clean,
        type: cloudType,
        hostingProvider: "sira-cloud",
      })
      await refresh()
      handleOpenWorkspace({
        id: codexIdForProject(project.id),
        name: project.name,
        kind: "project",
        chatListId: project.id,
      })
      toast.success(
        cloudType === "webapp"
          ? `App web "${project.name}" creada · disponible en Biblioteca → Apps web`
          : `Proyecto "${project.name}" creado`,
      )
      setCloudDialogOpen(false)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo crear el proyecto")
      setCreatingCloud(false)
    }
  }, [cloudName, cloudType, cloudHosting, creatingCloud, handleOpenWorkspace, refresh])

  // House pattern (create-project-dialog): clear state whenever the dialog
  // closes so a second open never inherits a stale name or a frozen spinner.
  React.useEffect(() => {
    if (!cloudDialogOpen) {
      setCloudName("")
      setCreatingCloud(false)
      setCloudType("general")
      setCloudHosting("sira-cloud")
    }
  }, [cloudDialogOpen])

  const handleSetDisplay = React.useCallback(
    <K extends keyof CodexDisplayOptions>(key: K, value: CodexDisplayOptions[K]) => {
      setDisplayOptions(setDisplayOption(key, value))
    },
    [],
  )

  const pickerSelectEntry = React.useCallback(
    (entry: CodexProjectEntry) => {
      if (entry.kind === "project") {
        const projectId = entry.id.replace(/^project:/, "")
        const folder = folders.find((f) => f.id === projectId)
        if (folder) {
          handleOpenWorkspace({
            id: entry.id,
            name: entry.name,
            kind: "project",
            chatListId: projectId,
          })
        } else {
          handleOpenInCode({ folderId: projectId })
        }
        return
      }
      handleOpenInCode({ localId: entry.id })
    },
    [folders, handleOpenInCode, handleOpenWorkspace],
  )

  const pickerProps = {
    onOpenFolder: handleOpenLocalProject,
    onSelectEntry: pickerSelectEntry,
    onOpenHome: () => handleOpenInCode({}),
    align: "start" as const,
    side: "right" as const,
  }

  if (collapsed) {
    return (
      <div className="flex justify-center px-2 pt-2">
        <CodexFolderPicker
          {...pickerProps}
          triggerVariant="codex-mark"
          side="right"
          triggerClassName={cn(
            isOnCodePage &&
              "bg-foreground/[0.065] text-foreground ring-1 ring-border/40",
          )}
        />
      </div>
    )
  }

  return (
    <div className="flex max-h-[min(560px,62vh)] min-h-[180px] flex-col px-1 pt-3">
      {error ? (
        <div className="mx-2 mb-2 rounded-md border border-rose-300/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <CodexWorkspaceTree
        workspaces={workspaceNodes}
        expandedIds={expandedIds}
        activeWorkspaceId={activeWorkspaceId}
        activeChatId={currentChat?.id ?? null}
        chatsByWorkspace={chatsByFolder}
        loading={loading}
        displayOptions={displayOptions}
        pinnedRows={pinnedRows}
        archivedRows={archivedRows}
        readRows={readRows}
        onToggleExpand={toggleExpanded}
        onOpenWorkspace={handleOpenWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        onOpenChat={handleOpenChat}
        onNewCodeChat={handleNewCodeChat}
        onSelectCodeSession={handleSelectCodeSession}
        activeCodeSessionId={activeCodeSessionId}
        listCodeSessions={listCodeSessions}
        onOpenSettings={handleOpenSettings}
        onRenameRow={handleRenameRow}
        onDeleteRow={handleDeleteRow}
        onMarkRead={handleMarkRead}
        onMarkUnread={handleMarkUnread}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleToggleArchive}
        headerRight={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  aria-label="Opciones de visualización"
                  title="Opciones de visualización"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Agrupar por</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={displayOptions.groupBy}
                  onValueChange={(v) => handleSetDisplay("groupBy", v as CodexDisplayOptions["groupBy"])}
                >
                  <DropdownMenuRadioItem value="project">Proyecto</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="status">Estado</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="none">Ninguno</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Ordenar conversaciones</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={displayOptions.sort}
                  onValueChange={(v) => handleSetDisplay("sort", v as CodexDisplayOptions["sort"])}
                >
                  <DropdownMenuRadioItem value="updated">Última actualización</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="alphabetical">Alfabético (A-Z)</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="created">Fecha de creación</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Subtítulos</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={displayOptions.subtitles}
                  onValueChange={(v) => handleSetDisplay("subtitles", v as CodexDisplayOptions["subtitles"])}
                >
                  <DropdownMenuRadioItem value="worktree">Workspace</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="none">Sin subtítulo</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  aria-label="Crear nuevo proyecto"
                  title="Crear nuevo proyecto"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="liquid-menu-surface w-64">
                <DropdownMenuItem
                  onClick={handleOpenLocalProject}
                  className="group liquid-menu-item gap-2.5 focus:bg-transparent data-[highlighted]:bg-transparent"
                >
                  <div className="liquid-icon flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-500/10 dark:bg-white/[0.06]">
                    <FolderOpen className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-300" />
                  </div>
                  <span className="liquid-label text-sm">Nuevo proyecto (carpeta local)</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleNewCloudProject}
                  data-accent="cloud"
                  className="group liquid-menu-item gap-2.5 focus:bg-transparent data-[highlighted]:bg-transparent"
                >
                  <div className="liquid-icon flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400/25 via-indigo-400/15 to-cyan-300/25 dark:from-violet-500/20 dark:via-indigo-500/15 dark:to-cyan-400/20">
                    <Cloud className="h-3.5 w-3.5 text-violet-700 dark:text-violet-200" />
                  </div>
                  <span className="liquid-label text-sm font-medium text-violet-900/90 dark:text-violet-100/90">
                    Proyecto en la nube
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => refresh()}
                  disabled={loading}
                  className="group liquid-menu-item gap-2.5 focus:bg-transparent data-[highlighted]:bg-transparent"
                >
                  <div className="liquid-icon flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-500/10 dark:bg-white/[0.06]">
                    <RefreshCw className={`h-3.5 w-3.5 text-zinc-600 dark:text-zinc-300 ${loading ? "animate-spin" : ""}`} />
                  </div>
                  <span className="liquid-label text-sm">Actualizar</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <Dialog
        open={cloudDialogOpen}
        onOpenChange={(open) => {
          if (!creatingCloud) setCloudDialogOpen(open)
        }}
      >
        <DialogContent showCloseButton={!creatingCloud} className="sm:max-w-[460px]">
          <DialogHeader>
            <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/15 to-indigo-500/15 ring-1 ring-sky-500/20">
              <Cloud className="h-5 w-5 text-sky-500" />
            </div>
            <DialogTitle className="text-xl tracking-tight">Nuevo proyecto en la nube</DialogTitle>
            <DialogDescription>
              Crea un workspace sincronizado en la nube. Podrás organizar tus chats y código dentro de él.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submitCloudProject()
            }}
            className="space-y-4 pt-1"
          >
            <div className="space-y-1.5">
              <Label htmlFor="cloud-project-name" className="text-sm">
                Nombre del proyecto
              </Label>
              <Input
                id="cloud-project-name"
                autoFocus
                value={cloudName}
                onChange={(e) => setCloudName(e.target.value)}
                placeholder="Ej. Marketing Q3, App de finanzas…"
                maxLength={120}
                disabled={creatingCloud}
                aria-describedby="cloud-project-hint"
                className={cn(
                  "h-11",
                  cloudNameDuplicate && "border-amber-500/60 focus-visible:ring-amber-500/40",
                )}
              />
              <p
                id="cloud-project-hint"
                role="status"
                aria-live="polite"
                className={cn(
                  "min-h-[1rem] text-xs",
                  cloudNameDuplicate && !creatingCloud
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {creatingCloud
                  ? "Creando proyecto…"
                  : cloudNameDuplicate
                    ? "Ya tienes un proyecto con ese nombre — puedes crearlo igualmente."
                    : canSubmitCloud
                      ? "Pulsa ⏎ para crear · Esc para cancelar"
                      : "Escribe un nombre · Esc para cancelar"}
              </p>
            </div>

            {/* Project kind — "App web" projects also surface in Library → Apps web. */}
            <div className="space-y-1.5">
              <Label className="text-sm">Tipo de proyecto</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: "general" as const, label: "Proyecto general", Icon: FolderOpen },
                    { value: "webapp" as const, label: "App web", Icon: Globe },
                  ]
                ).map(({ value, label, Icon }) => {
                  const active = cloudType === value
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCloudType(value)}
                      disabled={creatingCloud}
                      aria-pressed={active}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-60",
                        active
                          ? "border-sky-500/60 bg-sky-500/10 text-foreground ring-1 ring-sky-500/30"
                          : "border-border/60 hover:bg-muted/50",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-sky-500" : "text-muted-foreground")} />
                      <span className="min-w-0 truncate">{label}</span>
                    </button>
                  )
                })}
              </div>
              {cloudType === "webapp" ? (
                <p className="text-xs text-muted-foreground">
                  Aparecerá en <span className="font-medium">Biblioteca → Apps web</span>.
                </p>
              ) : null}
            </div>

            {/* Hosting destination — GitHub is reserved for the upcoming flow. */}
            <div className="space-y-1.5">
              <Label className="text-sm">Alojamiento</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCloudHosting("sira-cloud")}
                  disabled={creatingCloud}
                  aria-pressed={cloudHosting === "sira-cloud"}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-60",
                    cloudHosting === "sira-cloud"
                      ? "border-sky-500/60 bg-sky-500/10 text-foreground ring-1 ring-sky-500/30"
                      : "border-border/60 hover:bg-muted/50",
                  )}
                >
                  <Cloud className={cn("h-4 w-4 shrink-0", cloudHosting === "sira-cloud" ? "text-sky-500" : "text-muted-foreground")} />
                  <span className="min-w-0 truncate">Nube de SiraGPT</span>
                </button>
                <button
                  type="button"
                  onClick={() => setCloudHosting("github")}
                  disabled={creatingCloud}
                  aria-pressed={cloudHosting === "github"}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-60",
                    cloudHosting === "github"
                      ? "border-amber-500/60 bg-amber-500/10 text-foreground ring-1 ring-amber-500/30"
                      : "border-border/60 hover:bg-muted/50",
                  )}
                >
                  <Github className={cn("h-4 w-4 shrink-0", cloudHosting === "github" ? "text-amber-500" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1 truncate">GitHub</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Próximamente
                  </span>
                </button>
              </div>
              {githubSelected ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  La conexión con GitHub aún no está disponible. Usa la nube de SiraGPT por ahora.
                </p>
              ) : null}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCloudDialogOpen(false)}
                disabled={creatingCloud}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={!canSubmitCloud} aria-busy={creatingCloud}>
                {creatingCloud ? (
                  <>
                    <ThinkingIndicator size="sm" className="mr-2" />
                    Creando…
                  </>
                ) : (
                  <>
                    <Cloud aria-hidden="true" className="mr-2 h-4 w-4" />
                    Crear proyecto
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
