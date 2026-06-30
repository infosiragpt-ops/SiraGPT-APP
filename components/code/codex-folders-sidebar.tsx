"use client"

/**
 * CodexFoldersSidebar — Cursor-style Workspaces panel on /code (right column).
 */

import * as React from "react"
import { RefreshCw, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CodexFolderPicker } from "@/components/codex/codex-folder-picker"
import { CodexWorkspaceTree, type WorkspaceTreeNode } from "@/components/codex/codex-workspace-tree"
import {
  CODEX_UPDATED_EVENT,
  codexIdForProject,
  listCodexProjects,
  removeCodexProject,
  type CodexProjectEntry,
  upsertCodexProject,
} from "@/lib/codex-projects"
import {
  SWITCH_CODEX_WORKSPACE_EVENT,
  useCodeWorkspace,
  type CodeNewChatDetail,
} from "@/lib/code-workspace-context"
import { projectsService, type Project, type ProjectChatSummary } from "@/lib/projects-service"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

type Props = {
  onClose?: () => void
  variant?: "rail" | "panel"
}

export function CodexFoldersSidebar({ onClose, variant = "rail" }: Props) {
  const {
    activeFolder,
    openLocalFolderWorkspace,
    resetWorkspace,
    forgetWorkspace,
    activeCodeChatSessionId,
    setActiveCodeChatSession,
    listCodeChatSessionsForWorkspace,
    openWorkspaceNewCodeChat,
  } = useCodeWorkspace()
  const [projects, setProjects] = React.useState<Project[]>([])
  const [localEntries, setLocalEntries] = React.useState<CodexProjectEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [chatsByFolder, setChatsByFolder] = React.useState<
    Record<string, { loading: boolean; chats: ProjectChatSummary[]; error: string | null }>
  >({})

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [list, registry] = await Promise.all([
        projectsService.list({ sort: "activity" }),
        Promise.resolve(listCodexProjects()),
      ])
      setProjects(list)
      setLocalEntries(registry.filter((row) => row.kind === "local-folder"))
    } catch (err: any) {
      toast.error(err?.message || "No se pudieron cargar los workspaces")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  React.useEffect(() => {
    const handler = () => refresh()
    window.addEventListener(CODEX_UPDATED_EVENT, handler)
    return () => window.removeEventListener(CODEX_UPDATED_EVENT, handler)
  }, [refresh])

  const switchTo = React.useCallback(
    (detail: { id: string; name: string; kind: "local-folder" | "project"; projectId?: string }) => {
      window.dispatchEvent(new CustomEvent(SWITCH_CODEX_WORKSPACE_EVENT, { detail }))
    },
    [],
  )

  const workspaceNodes = React.useMemo<WorkspaceTreeNode[]>(() => {
    const locals: WorkspaceTreeNode[] = localEntries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: "local-folder",
      chatListId: entry.id,
    }))
    const cloud: WorkspaceTreeNode[] = projects.map((project) => ({
      id: codexIdForProject(project.id),
      name: project.name,
      kind: "project",
      chatListId: project.id,
      isPinned: project.isStarred,
    }))
    return [...locals, ...cloud]
  }, [localEntries, projects])

  const activeWorkspaceId = activeFolder?.id ?? null

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    setExpandedIds((prev) => new Set(prev).add(activeWorkspaceId))
  }, [activeWorkspaceId])

  const toggleExpanded = React.useCallback(
    (workspaceId: string) => {
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
    },
    [workspaceNodes],
  )

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

  const handleOpenWorkspace = React.useCallback(
    (node: WorkspaceTreeNode) => {
      if (node.kind === "project") {
        const project = projects.find((p) => p.id === node.chatListId)
        upsertCodexProject({
          id: node.id,
          name: node.name,
          kind: "project",
        })
        switchTo({
          id: node.id,
          name: node.name,
          kind: "project",
          projectId: node.chatListId,
        })
        if (project) return
      }
      const entry = localEntries.find((e) => e.id === node.id)
      if (entry) switchTo({ id: entry.id, name: entry.name, kind: "local-folder" })
    },
    [localEntries, projects, switchTo],
  )

  const handleDeleteWorkspace = React.useCallback(
    async (node: WorkspaceTreeNode) => {
      const isCloud = node.kind === "project"
      const message = isCloud
        ? `¿Eliminar el proyecto "${node.name}"? Se borrarán también sus chats. Esta acción no se puede deshacer.`
        : `¿Quitar la carpeta "${node.name}" de tus proyectos? No se borra ningún archivo de tu disco.`
      if (typeof window !== "undefined" && !window.confirm(message)) return
      try {
        if (isCloud) {
          await projectsService.remove(node.chatListId)
        }
        removeCodexProject(node.id)
        forgetWorkspace(node.id)
        setChatsByFolder((prev) => {
          if (!(node.chatListId in prev)) return prev
          const next = { ...prev }
          delete next[node.chatListId]
          return next
        })
        await refresh()
        toast.success(isCloud ? `Proyecto "${node.name}" eliminado.` : `Carpeta "${node.name}" quitada.`)
      } catch (err: any) {
        toast.error(err?.message || "No se pudo eliminar el proyecto")
      }
    },
    [forgetWorkspace, refresh],
  )

  const handleRenameWorkspace = React.useCallback(
    async (node: WorkspaceTreeNode, name: string) => {
      const clean = name.trim()
      if (!clean) return
      try {
        if (node.kind === "project") {
          const updated = await projectsService.update(node.chatListId, { name: clean })
          setProjects((prev) => prev.map((project) => (project.id === updated.id ? { ...project, ...updated } : project)))
          upsertCodexProject({ id: node.id, name: updated.name, kind: "project" })
          toast.success("Proyecto renombrado.")
          return
        }

        const entry = listCodexProjects().find((row) => row.id === node.id)
        if (entry) {
          upsertCodexProject({ ...entry, name: clean })
          setLocalEntries(listCodexProjects().filter((row) => row.kind === "local-folder"))
          window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
          toast.success("Carpeta renombrada en APPS.")
        }
      } catch (err: any) {
        toast.error(err?.message || "No se pudo cambiar el nombre del proyecto")
      }
    },
    [],
  )

  const handleToggleWorkspacePin = React.useCallback(
    async (node: WorkspaceTreeNode) => {
      if (node.kind !== "project") {
        toast.info("Las carpetas locales se ordenan por uso reciente; los proyectos cloud sí se pueden anclar.")
        return
      }

      const current = projects.find((project) => project.id === node.chatListId)
      const nextPinned = !current?.isStarred
      setProjects((prev) =>
        prev.map((project) =>
          project.id === node.chatListId ? { ...project, isStarred: nextPinned } : project,
        ),
      )
      try {
        await projectsService.update(node.chatListId, { isStarred: nextPinned })
        toast.success(nextPinned ? "Proyecto anclado." : "Proyecto desanclado.")
      } catch (err: any) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === node.chatListId ? { ...project, isStarred: !nextPinned } : project,
          ),
        )
        toast.error(err?.message || "No se pudo actualizar el anclado")
      }
    },
    [projects],
  )

  const handleRevealWorkspace = React.useCallback(
    (node: WorkspaceTreeNode) => {
      handleOpenWorkspace(node)
      toast.info(
        node.kind === "local-folder"
          ? "Carpeta abierta en APPS. Mostrarla en Finder requiere permisos nativos del navegador."
          : "Proyecto abierto. Para verlo en Finder primero crea o enlaza un worktree local.",
      )
    },
    [handleOpenWorkspace],
  )

  const handleCreatePermanentWorktree = React.useCallback(
    (node: WorkspaceTreeNode) => {
      handleOpenWorkspace(node)
      toast.info("Worktree permanente preparado para enlazarse cuando la integración nativa esté disponible.")
    },
    [handleOpenWorkspace],
  )

  const handleOpenChat = React.useCallback((chatId: string) => {
    if (typeof window === "undefined") return
    window.open(`/chat?id=${encodeURIComponent(chatId)}`, "_blank", "noopener,noreferrer")
  }, [])

  const handleNewCodeChat = React.useCallback(
    (node: WorkspaceTreeNode) => {
      const detail: CodeNewChatDetail = {
        workspaceId: node.id,
        name: node.name,
        kind: node.kind,
        projectId: node.kind === "project" ? node.chatListId : undefined,
      }
      void openWorkspaceNewCodeChat(detail)
    },
    [openWorkspaceNewCodeChat],
  )

  const handleSelectCodeSession = React.useCallback(
    (workspaceId: string, sessionId: string) => {
      if (activeFolder?.id !== workspaceId) {
        const node = workspaceNodes.find((n) => n.id === workspaceId)
        if (node) handleOpenWorkspace(node)
      }
      setActiveCodeChatSession(sessionId)
    },
    [activeFolder?.id, handleOpenWorkspace, setActiveCodeChatSession, workspaceNodes],
  )

  const listCodeSessions = React.useCallback(
    (workspaceId: string) =>
      listCodeChatSessionsForWorkspace(workspaceId).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    [listCodeChatSessionsForWorkspace],
  )

  const pickerSelectEntry = React.useCallback(
    (entry: CodexProjectEntry) => {
      if (entry.kind === "project") {
        const projectId = entry.id.replace(/^project:/, "")
        const project = projects.find((p) => p.id === projectId)
        if (project) {
          handleOpenWorkspace({
            id: entry.id,
            name: entry.name,
            kind: "project",
            chatListId: projectId,
          })
        } else {
          switchTo({
            id: entry.id,
            name: entry.name,
            kind: "project",
            projectId,
          })
        }
        return
      }
      handleOpenWorkspace({
        id: entry.id,
        name: entry.name,
        kind: "local-folder",
        chatListId: entry.id,
      })
    },
    [handleOpenWorkspace, projects, switchTo],
  )

  const pickerProps = {
    onOpenFolder: () => void openLocalFolderWorkspace(),
    onSelectEntry: pickerSelectEntry,
    onOpenHome: () => resetWorkspace(),
    align: "end" as const,
    side: "left" as const,
  }

  const isPanel = variant === "panel"

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-muted/10",
        !isPanel && "border-l border-border/60",
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <CodexWorkspaceTree
          workspaces={workspaceNodes}
          expandedIds={expandedIds}
          activeWorkspaceId={activeWorkspaceId}
          chatsByWorkspace={chatsByFolder}
          loading={loading}
          onToggleExpand={toggleExpanded}
          onOpenWorkspace={handleOpenWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onOpenChat={handleOpenChat}
          onNewCodeChat={handleNewCodeChat}
          onSelectCodeSession={handleSelectCodeSession}
          activeCodeSessionId={activeCodeChatSessionId}
          listCodeSessions={listCodeSessions}
          onRenameWorkspace={handleRenameWorkspace}
          onToggleWorkspacePin={handleToggleWorkspacePin}
          onRevealWorkspace={handleRevealWorkspace}
          onCreatePermanentWorktree={handleCreatePermanentWorktree}
          headerRight={
            <>
              <CodexFolderPicker {...pickerProps} triggerVariant="folder-plus" />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
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
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={onClose}
                  aria-label="Cerrar panel"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </>
          }
        />
      </div>

      <div className="shrink-0 border-t border-border/40 bg-muted/10 px-2 py-2">
        <CodexFolderPicker {...pickerProps} triggerVariant="open-workspace-row" />
      </div>
    </div>
  )
}
