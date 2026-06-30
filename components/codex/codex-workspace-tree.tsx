"use client"

import * as React from "react"
import {
  Archive,
  Check,
  CheckCheck,
  Circle,
  FolderClosed,
  FolderOpen,
  GitBranch,
  MailOpen,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Settings,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type { ProjectChatSummary } from "@/lib/projects-service"
import {
  DEFAULT_DISPLAY_OPTIONS,
  rowKey,
  type CodexDisplayOptions,
} from "@/lib/codex-conversation-prefs"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

export type WorkspaceTreeNode = {
  id: string
  name: string
  kind: "local-folder" | "project"
  /** Key for chatsByWorkspace (project UUID for cloud, codex id for local). */
  chatListId: string
  isPinned?: boolean
}

type ChatState = {
  loading: boolean
  chats: ProjectChatSummary[]
  error: string | null
}

export type ChatRow = {
  id: string
  title: string
  source: "code" | "cloud"
  updatedAt: number
  createdAt: number
  /** Owning workspace node id. */
  workspaceId: string
  /** `${source}:${id}` — stable preference key. */
  key: string
}

export type CodexWorkspaceTreeProps = {
  workspaces: WorkspaceTreeNode[]
  expandedIds: Set<string>
  activeWorkspaceId: string | null
  activeChatId?: string | null
  chatsByWorkspace: Record<string, ChatState | undefined>
  loading?: boolean
  displayOptions?: CodexDisplayOptions
  pinnedRows?: Set<string>
  archivedRows?: Set<string>
  readRows?: Set<string>
  onToggleExpand: (workspaceId: string) => void
  onOpenWorkspace: (node: WorkspaceTreeNode) => void
  onOpenChat: (chatId: string) => void
  onNewCodeChat?: (node: WorkspaceTreeNode) => void
  onSelectCodeSession?: (workspaceId: string, sessionId: string) => void
  activeCodeSessionId?: string | null
  listCodeSessions?: (workspaceId: string) => { id: string; title: string; updatedAt?: number; createdAt?: number }[]
  headerRight?: React.ReactNode
  onOpenSettings?: (node: WorkspaceTreeNode) => void
  onRenameWorkspace?: (node: WorkspaceTreeNode, name: string) => void
  onToggleWorkspacePin?: (node: WorkspaceTreeNode) => void
  onRevealWorkspace?: (node: WorkspaceTreeNode) => void
  onCreatePermanentWorktree?: (node: WorkspaceTreeNode) => void
  onDeleteWorkspace?: (node: WorkspaceTreeNode) => void
  onRenameRow?: (row: ChatRow, title: string) => void
  onDeleteRow?: (row: ChatRow) => void
  onMarkRead?: (row: ChatRow) => void
  onMarkUnread?: (row: ChatRow) => void
  onTogglePin?: (row: ChatRow) => void
  onToggleArchive?: (row: ChatRow) => void
}

type RowActions = Pick<
  CodexWorkspaceTreeProps,
  | "onRenameRow"
  | "onDeleteRow"
  | "onMarkRead"
  | "onMarkUnread"
  | "onTogglePin"
  | "onToggleArchive"
>

export function CodexWorkspaceTree(props: CodexWorkspaceTreeProps) {
  const {
    workspaces,
    expandedIds,
    activeWorkspaceId,
    activeChatId = null,
    chatsByWorkspace,
    loading,
    displayOptions = DEFAULT_DISPLAY_OPTIONS,
    pinnedRows,
    archivedRows,
    readRows,
    onToggleExpand,
    onOpenWorkspace,
    onOpenChat,
    onNewCodeChat,
    onSelectCodeSession,
    activeCodeSessionId = null,
    listCodeSessions,
    headerRight,
    onRenameWorkspace,
    onToggleWorkspacePin,
    onRevealWorkspace,
    onCreatePermanentWorktree,
    onDeleteWorkspace,
  } = props

  const pinned = pinnedRows ?? EMPTY_SET
  const archived = archivedRows ?? EMPTY_SET
  const read = readRows ?? EMPTY_SET

  // Inline rename state lives at tree level so only one row edits at a time.
  const [editingKey, setEditingKey] = React.useState<string | null>(null)
  const [editValue, setEditValue] = React.useState("")
  const [editingWorkspaceId, setEditingWorkspaceId] = React.useState<string | null>(null)
  const [workspaceEditValue, setWorkspaceEditValue] = React.useState("")

  const beginRename = React.useCallback((row: ChatRow) => {
    setEditingKey(row.key)
    setEditValue(row.title)
  }, [])
  const cancelRename = React.useCallback(() => {
    setEditingKey(null)
    setEditValue("")
  }, [])
  const commitRename = React.useCallback(
    (row: ChatRow) => {
      const next = editValue.trim()
      if (next && next !== row.title) props.onRenameRow?.(row, next)
      cancelRename()
    },
    [cancelRename, editValue, props],
  )

  const beginWorkspaceRename = React.useCallback((node: WorkspaceTreeNode) => {
    setEditingWorkspaceId(node.id)
    setWorkspaceEditValue(node.name)
  }, [])

  const cancelWorkspaceRename = React.useCallback(() => {
    setEditingWorkspaceId(null)
    setWorkspaceEditValue("")
  }, [])

  const commitWorkspaceRename = React.useCallback(
    (node: WorkspaceTreeNode) => {
      const next = workspaceEditValue.trim()
      if (next && next !== node.name) onRenameWorkspace?.(node, next)
      cancelWorkspaceRename()
    },
    [cancelWorkspaceRename, onRenameWorkspace, workspaceEditValue],
  )

  const expandedOnceRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    for (const ws of workspaces) {
      if (ws.kind !== "project") continue
      if (expandedOnceRef.current.has(ws.id)) continue
      expandedOnceRef.current.add(ws.id)
      if (!expandedIds.has(ws.id)) onToggleExpand(ws.id)
    }
  }, [workspaces, expandedIds, onToggleExpand])

  const rowActions: RowActions = {
    onRenameRow: props.onRenameRow,
    onDeleteRow: props.onDeleteRow,
    onMarkRead: props.onMarkRead,
    onMarkUnread: props.onMarkUnread,
    onTogglePin: props.onTogglePin,
    onToggleArchive: props.onToggleArchive,
  }

  const isRowActive = React.useCallback(
    (row: ChatRow) => {
      if (row.source === "code") return activeWorkspaceId === row.workspaceId && activeCodeSessionId === row.id
      return activeChatId === row.id
    },
    [activeWorkspaceId, activeCodeSessionId, activeChatId],
  )

  const isRowUnread = React.useCallback(
    (row: ChatRow) => row.source === "cloud" && !read.has(row.key),
    [read],
  )

  const openRow = React.useCallback(
    (row: ChatRow) => {
      props.onMarkRead?.(row)
      if (row.source === "code") {
        const node = workspaces.find((n) => n.id === row.workspaceId)
        if (node) onOpenWorkspace(node)
        onSelectCodeSession?.(row.workspaceId, row.id)
        return
      }
      onOpenChat(row.id)
    },
    [onOpenChat, onOpenWorkspace, onSelectCodeSession, props, workspaces],
  )

  const buildRows = React.useCallback(
    (node: WorkspaceTreeNode): ChatRow[] => {
      const codeSessions = listCodeSessions?.(node.id) ?? []
      const cloudChats = chatsByWorkspace[node.chatListId]?.chats ?? []
      const rows: ChatRow[] = [
        ...codeSessions.map((s) => ({
          id: s.id,
          title: s.title,
          source: "code" as const,
          updatedAt: s.updatedAt ?? 0,
          createdAt: s.createdAt ?? s.updatedAt ?? 0,
          workspaceId: node.id,
          key: rowKey("code", s.id),
        })),
        ...cloudChats.map((c) => ({
          id: c.id,
          title: c.title,
          source: "cloud" as const,
          updatedAt: Date.parse(c.updatedAt) || 0,
          createdAt: Date.parse(c.createdAt) || 0,
          workspaceId: node.id,
          key: rowKey("cloud", c.id),
        })),
      ]
      return rows.filter((r) => !archived.has(r.key))
    },
    [archived, chatsByWorkspace, listCodeSessions],
  )

  const sortRows = React.useCallback(
    (rows: ChatRow[]): ChatRow[] => {
      const cmp = (a: ChatRow, b: ChatRow) => {
        // Pinned rows always float to the top of their group.
        const pinDelta = Number(pinned.has(b.key)) - Number(pinned.has(a.key))
        if (pinDelta) return pinDelta
        switch (displayOptions.sort) {
          case "alphabetical":
            return a.title.localeCompare(b.title)
          case "created":
            return b.createdAt - a.createdAt
          default:
            return b.updatedAt - a.updatedAt
        }
      }
      return [...rows].sort(cmp)
    },
    [displayOptions.sort, pinned],
  )

  const sortedWorkspaces = React.useMemo(
    () =>
      workspaces
        .map((workspace, index) => ({ workspace, index }))
        .sort((a, b) => {
          const pinnedDelta = Number(Boolean(b.workspace.isPinned)) - Number(Boolean(a.workspace.isPinned))
          return pinnedDelta || a.index - b.index
        })
        .map(({ workspace }) => workspace),
    [workspaces],
  )

  const sharedRowProps = {
    actions: rowActions,
    pinned,
    read,
    editingKey,
    editValue,
    setEditValue,
    beginRename,
    cancelRename,
    commitRename,
    isRowActive,
    isRowUnread,
    openRow,
    subtitles: displayOptions.subtitles,
    workspaces: sortedWorkspaces,
  }

  const header = (
    <div className="flex shrink-0 items-center justify-end gap-0.5 px-2.5 py-1.5">
      {headerRight}
    </div>
  )

  const renderEmpty = () =>
    loading && workspaces.length === 0 ? (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
        <ThinkingIndicator size="sm" />
        Cargando…
      </div>
    ) : null

  // ── group-by: status / none flatten every workspace into one stream ──
  if (workspaces.length > 0 && displayOptions.groupBy !== "project") {
    const allRows = sortRows(sortedWorkspaces.flatMap((ws) => buildRows(ws)))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {displayOptions.groupBy === "status" ? (
            <FlatStatusGroups rows={allRows} sharedRowProps={sharedRowProps} />
          ) : (
            <ul className="space-y-0.5">
              {allRows.map((row) => (
                <ConversationRow key={row.key} row={row} {...sharedRowProps} />
              ))}
              {allRows.length === 0 ? <EmptyHint /> : null}
            </ul>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {renderEmpty()}
        {workspaces.length > 0 ? (
          <ul className="space-y-3">
            {sortedWorkspaces.map((ws) => (
              <WorkspaceFolderBlock
                key={ws.id}
                node={ws}
                isActiveWorkspace={activeWorkspaceId === ws.id}
                state={chatsByWorkspace[ws.chatListId]}
                rows={sortRows(buildRows(ws))}
                onOpenWorkspace={() => onOpenWorkspace(ws)}
                onNewCodeChat={onNewCodeChat}
                onRenameWorkspace={onRenameWorkspace ? () => beginWorkspaceRename(ws) : undefined}
                onToggleWorkspacePin={onToggleWorkspacePin ? () => onToggleWorkspacePin(ws) : undefined}
                onRevealWorkspace={onRevealWorkspace ? () => onRevealWorkspace(ws) : undefined}
                onCreatePermanentWorktree={onCreatePermanentWorktree ? () => onCreatePermanentWorktree(ws) : undefined}
                onDeleteWorkspace={onDeleteWorkspace ? () => onDeleteWorkspace(ws) : undefined}
                editingWorkspaceId={editingWorkspaceId}
                workspaceEditValue={workspaceEditValue}
                setWorkspaceEditValue={setWorkspaceEditValue}
                cancelWorkspaceRename={cancelWorkspaceRename}
                commitWorkspaceRename={() => commitWorkspaceRename(ws)}
                sharedRowProps={sharedRowProps}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

const EMPTY_SET: Set<string> = new Set()

type SharedRowProps = {
  actions: RowActions
  pinned: Set<string>
  read: Set<string>
  editingKey: string | null
  editValue: string
  setEditValue: (value: string) => void
  beginRename: (row: ChatRow) => void
  cancelRename: () => void
  commitRename: (row: ChatRow) => void
  isRowActive: (row: ChatRow) => boolean
  isRowUnread: (row: ChatRow) => boolean
  openRow: (row: ChatRow) => void
  subtitles: CodexDisplayOptions["subtitles"]
  workspaces: WorkspaceTreeNode[]
}

function EmptyHint() {
  return <li className="px-1 py-0.5 text-[11px] text-muted-foreground/45">Sin conversaciones</li>
}

function FlatStatusGroups({
  rows,
  sharedRowProps,
}: {
  rows: ChatRow[]
  sharedRowProps: SharedRowProps
}) {
  const unread = rows.filter((r) => sharedRowProps.isRowUnread(r))
  const rest = rows.filter((r) => !sharedRowProps.isRowUnread(r))
  return (
    <div className="space-y-3">
      {unread.length ? (
        <div>
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
            Sin leer
          </p>
          <ul className="space-y-0.5">
            {unread.map((row) => (
              <ConversationRow key={row.key} row={row} {...sharedRowProps} />
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
          Leídos
        </p>
        <ul className="space-y-0.5">
          {rest.map((row) => (
            <ConversationRow key={row.key} row={row} {...sharedRowProps} />
          ))}
          {rest.length === 0 && unread.length === 0 ? <EmptyHint /> : null}
        </ul>
      </div>
    </div>
  )
}

function WorkspaceFolderBlock({
  node,
  isActiveWorkspace,
  state,
  rows,
  onOpenWorkspace,
  onNewCodeChat,
  onRenameWorkspace,
  onToggleWorkspacePin,
  onRevealWorkspace,
  onCreatePermanentWorktree,
  onDeleteWorkspace,
  editingWorkspaceId,
  workspaceEditValue,
  setWorkspaceEditValue,
  cancelWorkspaceRename,
  commitWorkspaceRename,
  sharedRowProps,
}: {
  node: WorkspaceTreeNode
  isActiveWorkspace: boolean
  state: ChatState | undefined
  rows: ChatRow[]
  onOpenWorkspace: () => void
  onNewCodeChat?: (node: WorkspaceTreeNode) => void
  onRenameWorkspace?: () => void
  onToggleWorkspacePin?: () => void
  onRevealWorkspace?: () => void
  onCreatePermanentWorktree?: () => void
  onDeleteWorkspace?: () => void
  editingWorkspaceId: string | null
  workspaceEditValue: string
  setWorkspaceEditValue: (value: string) => void
  cancelWorkspaceRename: () => void
  commitWorkspaceRename: () => void
  sharedRowProps: SharedRowProps
}) {
  const editing = editingWorkspaceId === node.id

  const markWorkspaceRead = React.useCallback(() => {
    if (rows.length === 0) {
      toast.info("Este proyecto no tiene chats para marcar.")
      return
    }
    rows.forEach((row) => sharedRowProps.actions.onMarkRead?.(row))
    toast.success("Chats marcados como leídos.")
  }, [rows, sharedRowProps.actions])

  const archiveWorkspaceChats = React.useCallback(() => {
    if (rows.length === 0) {
      toast.info("Este proyecto no tiene chats para archivar.")
      return
    }
    rows.forEach((row) => sharedRowProps.actions.onToggleArchive?.(row))
    toast.success("Chats archivados.")
  }, [rows, sharedRowProps.actions])

  return (
    <li>
      <div className="group/folder relative flex items-center">
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-muted/50 px-1 py-0.5">
            <FolderClosed className="h-4 w-4 shrink-0 text-muted-foreground/65" />
            <input
              value={workspaceEditValue}
              autoFocus
              onChange={(e) => setWorkspaceEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitWorkspaceRename()
                if (e.key === "Escape") cancelWorkspaceRename()
              }}
              onBlur={commitWorkspaceRename}
              className="h-6 min-w-0 flex-1 rounded border-0 bg-transparent px-1 text-[13px] font-medium outline-none focus:ring-1 focus:ring-border"
            />
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-emerald-600 hover:bg-emerald-500/10"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitWorkspaceRename}
              aria-label="Guardar nombre"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-rose-500 hover:bg-rose-500/10"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelWorkspaceRename}
              aria-label="Cancelar cambio de nombre"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
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
            {node.isPinned ? (
              <Pin className="h-3 w-3 shrink-0 text-muted-foreground/55" aria-label="Proyecto anclado" />
            ) : null}
          </button>
        )}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/folder:opacity-100">
          <WorkspaceSettingsMenu
            node={node}
            isPinned={Boolean(node.isPinned)}
            onTogglePin={onToggleWorkspacePin}
            onRevealWorkspace={onRevealWorkspace}
            onCreatePermanentWorktree={onCreatePermanentWorktree}
            onRenameWorkspace={onRenameWorkspace}
            onMarkWorkspaceRead={markWorkspaceRead}
            onArchiveWorkspaceChats={archiveWorkspaceChats}
            onDeleteWorkspace={onDeleteWorkspace}
          />
          {onNewCodeChat ? (
            <FolderIconButton label="Nuevo chat" onClick={() => onNewCodeChat(node)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </FolderIconButton>
          ) : null}
        </div>
      </div>

      <ul className="mt-0.5 space-y-0.5 pl-[22px] pr-0.5">
        {state?.loading && node.kind === "project" && rows.length === 0 ? (
          <li className="px-1 py-1 text-[11px] text-muted-foreground/70">
            <ThinkingIndicator size="xs" className="mr-1 inline opacity-70" />
            Cargando…
          </li>
        ) : null}
        {state?.error ? (
          <li className="px-1 py-1 text-[11px] text-rose-500">{state.error}</li>
        ) : null}
        {rows.map((row) => (
          <ConversationRow key={row.key} row={row} {...sharedRowProps} />
        ))}
        {!state?.loading && rows.length === 0 ? (
          <li className="px-1 py-0.5 text-[11px] text-muted-foreground/45">Sin chats</li>
        ) : null}
      </ul>
    </li>
  )
}

function WorkspaceSettingsMenu({
  node,
  isPinned,
  onTogglePin,
  onRevealWorkspace,
  onCreatePermanentWorktree,
  onRenameWorkspace,
  onMarkWorkspaceRead,
  onArchiveWorkspaceChats,
  onDeleteWorkspace,
}: {
  node: WorkspaceTreeNode
  isPinned: boolean
  onTogglePin?: () => void
  onRevealWorkspace?: () => void
  onCreatePermanentWorktree?: () => void
  onRenameWorkspace?: () => void
  onMarkWorkspaceRead: () => void
  onArchiveWorkspaceChats: () => void
  onDeleteWorkspace?: () => void
}) {
  const revealWorkspace = React.useCallback(() => {
    if (onRevealWorkspace) {
      onRevealWorkspace()
      return
    }
    toast.info(
      node.kind === "local-folder"
        ? "La carpeta ya está enlazada en APPS. Finder requiere permisos nativos del navegador."
        : "Este proyecto vive en SiraGPT Cloud. Crea un worktree permanente para enlazarlo al disco.",
    )
  }, [node.kind, onRevealWorkspace])

  const createPermanentWorktree = React.useCallback(() => {
    if (onCreatePermanentWorktree) {
      onCreatePermanentWorktree()
      return
    }
    toast.info("El worktree permanente estará disponible cuando el proyecto tenga una carpeta local enlazada.")
  }, [onCreatePermanentWorktree])

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[state=open]:bg-muted/70 data-[state=open]:text-foreground"
              aria-label="Ajustes del proyecto"
              onClick={(e) => e.stopPropagation()}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Ajustes del proyecto</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="right"
        sideOffset={8}
        className="project-settings-menu liquid-menu-surface w-64"
        onClick={(e) => e.stopPropagation()}
      >
        <ProjectSettingsMenuItem
          icon={isPinned ? PinOff : Pin}
          label={isPinned ? "Desanclar proyecto" : "Anclar proyecto"}
          onSelect={onTogglePin}
        />
        <ProjectSettingsMenuItem icon={FolderOpen} label="Mostrar en Finder" onSelect={revealWorkspace} />
        <ProjectSettingsMenuItem
          icon={GitBranch}
          label="Crear un worktree permanente"
          onSelect={createPermanentWorktree}
        />
        <ProjectSettingsMenuItem icon={Pencil} label="Cambiar el nombre del proyecto" onSelect={onRenameWorkspace} />
        <ProjectSettingsMenuItem icon={CheckCheck} label="Marcar todo como leído" onSelect={onMarkWorkspaceRead} />
        <ProjectSettingsMenuItem icon={Archive} label="Archivar chats" onSelect={onArchiveWorkspaceChats} />
        <DropdownMenuSeparator className="project-settings-menu__separator" />
        <ProjectSettingsMenuItem
          icon={Trash2}
          label="Eliminar"
          onSelect={onDeleteWorkspace}
          destructive
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ProjectSettingsMenuItem({
  icon: Icon,
  label,
  onSelect,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onSelect?: () => void
  destructive?: boolean
}) {
  return (
    <DropdownMenuItem
      className={cn(
        "group liquid-menu-item project-settings-menu__item cursor-pointer gap-2 text-[13px] font-medium",
        destructive && "project-settings-menu__item--danger text-rose-600 focus:text-rose-700 dark:text-rose-400 dark:focus:text-rose-300",
      )}
      onClick={(e) => {
        e.stopPropagation()
        onSelect?.()
      }}
    >
      <span
        className={cn(
          "liquid-icon project-settings-menu__icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/72 text-muted-foreground ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10",
          destructive && "text-rose-500",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="liquid-label min-w-0 flex-1 truncate">{label}</span>
    </DropdownMenuItem>
  )
}

function FolderIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function ConversationRow({
  row,
  actions,
  pinned,
  editingKey,
  editValue,
  setEditValue,
  cancelRename,
  commitRename,
  beginRename,
  isRowActive,
  isRowUnread,
  openRow,
  subtitles,
  workspaces,
}: { row: ChatRow } & SharedRowProps) {
  const active = isRowActive(row)
  const unread = isRowUnread(row)
  const isPinned = pinned.has(row.key)
  const editing = editingKey === row.key
  const subtitle =
    subtitles === "worktree"
      ? workspaces.find((w) => w.id === row.workspaceId)?.name ?? null
      : null

  if (editing) {
    return (
      <li>
        <div className="flex items-center gap-1 rounded-md bg-muted/40 px-1.5 py-1">
          <input
            value={editValue}
            autoFocus
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(row)
              if (e.key === "Escape") cancelRename()
            }}
            onBlur={() => commitRename(row)}
            className="h-6 min-w-0 flex-1 rounded border-0 bg-transparent px-1 text-[12px] outline-none focus:ring-1 focus:ring-border"
          />
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-emerald-600 hover:bg-emerald-500/10"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitRename(row)}
            aria-label="Guardar"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-rose-500 hover:bg-rose-500/10"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelRename}
            aria-label="Cancelar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </li>
    )
  }

  return (
    <li>
      <div
        className={cn(
          "group/row flex w-full min-w-0 items-center gap-2 rounded-md py-1 pl-1 pr-0.5 text-left text-[12px] leading-snug transition-colors",
          active
            ? "bg-muted/80 text-foreground"
            : "text-muted-foreground/60 hover:bg-muted/35 hover:text-muted-foreground/90",
        )}
      >
        <button
          type="button"
          onClick={() => openRow(row)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={row.title}
        >
          {active ? (
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-foreground/85" />
          ) : unread ? (
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-sky-500" aria-label="Sin leer" />
          ) : (
            <Circle className="h-[9px] w-[9px] shrink-0 text-muted-foreground/35" strokeWidth={1.25} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{row.title}</span>
            {subtitle ? (
              <span className="block truncate text-[10px] text-muted-foreground/45">{subtitle}</span>
            ) : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
          <RowMenu row={row} actions={actions} unread={unread} beginRename={beginRename} />
          <RowIconButton
            label={isPinned ? "Quitar fijado" : "Fijar conversación"}
            active={isPinned}
            onClick={() => actions.onTogglePin?.(row)}
          >
            {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </RowIconButton>
          <RowIconButton
            label="Archivar conversación"
            onClick={() => actions.onToggleArchive?.(row)}
          >
            <Archive className="h-3.5 w-3.5" />
          </RowIconButton>
        </div>
        {isPinned ? (
          <Pin className="h-3 w-3 shrink-0 text-muted-foreground/45 group-hover/row:hidden" aria-label="Fijado" />
        ) : null}
      </div>
    </li>
  )
}

function RowIconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            active && "text-foreground",
          )}
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function RowMenu({
  row,
  actions,
  unread,
  beginRename,
}: {
  row: ChatRow
  actions: RowActions
  unread: boolean
  beginRename: (row: ChatRow) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground data-[state=open]:bg-muted/70 data-[state=open]:text-foreground"
          aria-label="Opciones de conversación"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuItem
          onClick={() => (unread ? actions.onMarkRead?.(row) : actions.onMarkUnread?.(row))}
        >
          <MailOpen className="mr-2 h-4 w-4" />
          {unread ? "Marcar como leída" : "Marcar como no leída"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => beginRename(row)}>
          <Pencil className="mr-2 h-4 w-4" />
          Renombrar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-rose-600 focus:text-rose-600"
          onClick={() => actions.onDeleteRow?.(row)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Eliminar conversación
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
