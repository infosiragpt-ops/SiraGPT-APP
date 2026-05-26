"use client"

/**
 * SidebarFoldersDropdown — Codex workspaces block in the app sidebar.
 */

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { RefreshCw, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CodexFolderPicker } from "@/components/codex/codex-folder-picker"
import { CodexWorkspaceTree, type WorkspaceTreeNode } from "@/components/codex/codex-workspace-tree"
import {
  CODE_CHAT_SESSIONS_UPDATED_EVENT,
  codexWorkspaceSessionKey,
  getActiveSessionId,
  listSessionsForWorkspace,
  readCodeChatStore,
} from "@/lib/code-chat-sessions"
import {
  CODE_NEW_CODE_CHAT_EVENT,
  CODE_SELECT_CHAT_SESSION_EVENT,
  type CodeNewChatDetail,
} from "@/lib/code-workspace-context"
import { useChat } from "@/lib/chat-context-integrated"
import {
  CODEX_UPDATED_EVENT,
  codexIdForProject,
  listCodexProjects,
  type CodexProjectEntry,
  upsertCodexProject,
} from "@/lib/codex-projects"
import { projectsService, type Project, type ProjectChatSummary } from "@/lib/projects-service"
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

const STORAGE_EXPANDED = "code-workspace:expanded-workspaces"
const STORAGE_ACTIVE_FOLDER = "code-workspace:active-folder"

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

  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [chatsByFolder, setChatsByFolder] = React.useState<
    Record<string, { loading: boolean; chats: ProjectChatSummary[]; error: string | null }>
  >({})
  const [activeFolderId, setActiveFolderId] = React.useState<string | null>(null)
  const [codeAgentStore, setCodeAgentStore] = React.useState(readCodeChatStore)

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
      router.push(query ? `/code?${query}` : "/code")
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
    onOpenFolder: handleOpenDesktopFolder,
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
    <div className="flex max-h-[min(420px,50vh)] min-h-[120px] flex-col px-1 pt-3">
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
        onToggleExpand={toggleExpanded}
        onOpenWorkspace={handleOpenWorkspace}
        onOpenChat={handleOpenChat}
        onNewCodeChat={handleNewCodeChat}
        onSelectCodeSession={handleSelectCodeSession}
        activeCodeSessionId={activeCodeSessionId}
        listCodeSessions={listCodeSessions}
        headerRight={
          <>
            <CodexFolderPicker {...pickerProps} triggerVariant="folder-plus" triggerClassName="h-6 w-6" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => refresh()}
                  aria-label="Actualizar"
                  disabled={loading}
                >
                  {loading ? (
                    <ThinkingIndicator size="sm" className="h-3.5 w-3.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Actualizar</p>
              </TooltipContent>
            </Tooltip>
          </>
        }
      />

      <div className="shrink-0 border-t border-border/40 px-2 py-2">
        <CodexFolderPicker {...pickerProps} triggerVariant="open-workspace-row" />
      </div>
    </div>
  )
}
