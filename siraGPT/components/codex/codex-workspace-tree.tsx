"use client"

import * as React from "react"
import { Circle, FolderClosed, ListFilter, Pencil } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ProjectChatSummary } from "@/lib/projects-service"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

export type WorkspaceTreeNode = {
  id: string
  name: string
  kind: "local-folder" | "project"
  /** Key for chatsByWorkspace (project UUID for cloud, codex id for local). */
  chatListId: string
}

type ChatState = {
  loading: boolean
  chats: ProjectChatSummary[]
  error: string | null
}

type ChatRow = {
  id: string
  title: string
  source: "code" | "cloud"
  updatedAt: number
}

export type CodexWorkspaceTreeProps = {
  workspaces: WorkspaceTreeNode[]
  expandedIds: Set<string>
  activeWorkspaceId: string | null
  activeChatId?: string | null
  chatsByWorkspace: Record<string, ChatState | undefined>
  loading?: boolean
  onToggleExpand: (workspaceId: string) => void
  onOpenWorkspace: (node: WorkspaceTreeNode) => void
  onOpenChat: (chatId: string) => void
  onNewCodeChat?: (node: WorkspaceTreeNode) => void
  onSelectCodeSession?: (workspaceId: string, sessionId: string) => void
  activeCodeSessionId?: string | null
  listCodeSessions?: (workspaceId: string) => { id: string; title: string; updatedAt?: number }[]
  headerRight?: React.ReactNode
}

export function CodexWorkspaceTree({
  workspaces,
  expandedIds,
  activeWorkspaceId,
  activeChatId = null,
  chatsByWorkspace,
  loading,
  onToggleExpand,
  onOpenWorkspace,
  onOpenChat,
  onNewCodeChat,
  onSelectCodeSession,
  activeCodeSessionId = null,
  listCodeSessions,
  headerRight,
}: CodexWorkspaceTreeProps) {
  const expandedOnceRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    for (const ws of workspaces) {
      if (ws.kind !== "project") continue
      if (expandedOnceRef.current.has(ws.id)) continue
      expandedOnceRef.current.add(ws.id)
      if (!expandedIds.has(ws.id)) onToggleExpand(ws.id)
    }
  }, [workspaces, expandedIds, onToggleExpand])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 px-2.5 py-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-label="Filtrar workspaces"
            title="Filtrar"
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>
          {headerRight}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {loading && workspaces.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <ThinkingIndicator size="sm" />
            Cargando…
          </div>
        ) : workspaces.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-snug text-muted-foreground/75">
            Abre un workspace abajo para empezar.
          </p>
        ) : (
          <ul className="space-y-3">
            {workspaces.map((ws) => (
              <WorkspaceFolderBlock
                key={ws.id}
                node={ws}
                isActiveWorkspace={activeWorkspaceId === ws.id}
                activeChatId={activeChatId}
                state={chatsByWorkspace[ws.chatListId]}
                onOpenWorkspace={() => onOpenWorkspace(ws)}
                onOpenChat={onOpenChat}
                onNewCodeChat={onNewCodeChat}
                onSelectCodeSession={onSelectCodeSession}
                activeCodeSessionId={activeCodeSessionId}
                codeSessions={listCodeSessions?.(ws.id) ?? []}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function buildChatRows(
  codeSessions: { id: string; title: string; updatedAt?: number }[],
  cloudChats: ProjectChatSummary[],
): ChatRow[] {
  const rows: ChatRow[] = [
    ...codeSessions.map((s) => ({
      id: s.id,
      title: s.title,
      source: "code" as const,
      updatedAt: s.updatedAt ?? 0,
    })),
    ...cloudChats.map((c) => ({
      id: c.id,
      title: c.title,
      source: "cloud" as const,
      updatedAt: Date.parse(c.updatedAt) || 0,
    })),
  ]
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

function WorkspaceFolderBlock({
  node,
  isActiveWorkspace,
  activeChatId,
  state,
  onOpenWorkspace,
  onOpenChat,
  onNewCodeChat,
  onSelectCodeSession,
  activeCodeSessionId,
  codeSessions,
}: {
  node: WorkspaceTreeNode
  isActiveWorkspace: boolean
  activeChatId: string | null
  state: ChatState | undefined
  onOpenWorkspace: () => void
  onOpenChat: (chatId: string) => void
  onNewCodeChat?: (node: WorkspaceTreeNode) => void
  onSelectCodeSession?: (workspaceId: string, sessionId: string) => void
  activeCodeSessionId?: string | null
  codeSessions: { id: string; title: string; updatedAt?: number }[]
}) {
  const chatRows = buildChatRows(codeSessions, state?.chats ?? [])

  return (
    <li>
      <div className="group relative flex items-center">
        <button
          type="button"
          onClick={onOpenWorkspace}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left transition-colors",
            isActiveWorkspace ? "text-foreground" : "text-foreground/90 hover:text-foreground",
          )}
          title={node.name}
        >
          <FolderClosed className="h-4 w-4 shrink-0 text-muted-foreground/75" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.name}</span>
        </button>
        {onNewCodeChat ? (
          <button
            type="button"
            className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground group-hover:opacity-100"
            aria-label={`Nuevo chat en ${node.name}`}
            title="Nuevo chat"
            onClick={(e) => {
              e.stopPropagation()
              onNewCodeChat(node)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <ul className="mt-0.5 space-y-0.5 pl-[22px] pr-0.5">
        {state?.loading && node.kind === "project" && chatRows.length === 0 ? (
          <li className="px-1 py-1 text-[11px] text-muted-foreground/70">
            <ThinkingIndicator size="xs" className="mr-1 inline opacity-70" />
            Cargando…
          </li>
        ) : null}
        {state?.error ? (
          <li className="px-1 py-1 text-[11px] text-rose-500">{state.error}</li>
        ) : null}
        {chatRows.map((row) => {
          const activeCode = row.source === "code" && isActiveWorkspace && activeCodeSessionId === row.id
          const activeCloud = row.source === "cloud" && activeChatId === row.id
          const active = activeCode || activeCloud
          return (
            <li key={`${row.source}:${row.id}`}>
              <button
                type="button"
                onClick={() => {
                  if (row.source === "code") {
                    onOpenWorkspace()
                    onSelectCodeSession?.(node.id, row.id)
                    return
                  }
                  onOpenChat(row.id)
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-1 text-left text-[12px] leading-snug transition-colors",
                  active
                    ? "bg-muted/80 text-foreground"
                    : "text-muted-foreground/50 hover:bg-muted/35 hover:text-muted-foreground/80",
                )}
                title={row.title}
              >
                {active ? (
                  <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-foreground/85" />
                ) : (
                  <Circle className="h-[9px] w-[9px] shrink-0 text-muted-foreground/35" strokeWidth={1.25} />
                )}
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
              </button>
            </li>
          )
        })}
        {!state?.loading && chatRows.length === 0 ? (
          <li className="px-1 py-0.5 text-[11px] text-muted-foreground/45">Sin chats</li>
        ) : null}
      </ul>
    </li>
  )
}
