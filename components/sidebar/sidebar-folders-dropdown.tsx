"use client"

/**
 * SidebarFoldersDropdown — collapsible "Carpetas" section that sits in
 * the sidebar between the static nav and the recent-chats list. Each
 * row is a folder (a Project from /api/projects) that the user can
 * expand to see and open the chats inside it. The header has a
 * "Cursor" affordance that jumps into /code with the folder selected
 * as the active workspace.
 *
 * Why folders == projects:
 *   The backend already models a "folder of chats with shared files
 *   and instructions" as a Project. Adding a separate folder concept
 *   would duplicate that. Reusing Projects keeps one source of truth
 *   and means existing chats placed into a project (Chat.projectId)
 *   appear here automatically.
 *
 * Persistence:
 *   The set of expanded folders is kept in localStorage so a refresh
 *   restores the user's open trees. The "active folder" used by /code
 *   is read from the URL (?folder=) and from `code-workspace:active-folder`
 *   so it is shareable and survives reloads.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, FolderClosed, FolderOpen, Plus, RefreshCw, Square, SquareCheck, Terminal } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useChat } from "@/lib/chat-context-integrated"
import { projectsService, type Project, type ProjectChatSummary } from "@/lib/projects-service"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
const STORAGE_EXPANDED = "code-workspace:expanded-folders"
const STORAGE_ACTIVE = "code-workspace:active-folder"

type Props = {
  collapsed: boolean
  onMobileNavigate?: () => void
}

export function SidebarFoldersDropdown({ collapsed, onMobileNavigate }: Props) {
  const router = useRouter()
  const { selectChat } = useChat()

  const [folders, setFolders] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [open, setOpen] = React.useState(true)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [chatsByFolder, setChatsByFolder] = React.useState<
    Record<string, { loading: boolean; chats: ProjectChatSummary[]; error: string | null }>
  >({})
  const [activeFolderId, setActiveFolderId] = React.useState<string | null>(null)

  // Restore expanded + active folder from localStorage on mount.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_EXPANDED)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) setExpandedIds(new Set(arr.filter((v) => typeof v === "string")))
      }
      const active = window.localStorage.getItem(STORAGE_ACTIVE)
      if (active) setActiveFolderId(active)
    } catch {
      /* corrupted storage — ignore */
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
      setError(err?.message || "No se pudieron cargar las carpetas")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const toggleExpanded = React.useCallback(
    (id: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
      // Lazy-load chats the first time a folder is opened.
      setChatsByFolder((prev) => {
        if (prev[id]?.chats?.length || prev[id]?.loading) return prev
        return { ...prev, [id]: { loading: true, chats: [], error: null } }
      })
    },
    [],
  )

  React.useEffect(() => {
    const pendingId = Array.from(expandedIds).find(
      (id) => chatsByFolder[id]?.loading && !chatsByFolder[id]?.chats?.length,
    )
    if (!pendingId) return
    let cancelled = false
    ;(async () => {
      try {
        const chats = await projectsService.listChats(pendingId, { limit: 12 })
        if (cancelled) return
        setChatsByFolder((prev) => ({
          ...prev,
          [pendingId]: { loading: false, chats, error: null },
        }))
      } catch (err: any) {
        if (cancelled) return
        setChatsByFolder((prev) => ({
          ...prev,
          [pendingId]: {
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
  }, [expandedIds, chatsByFolder])

  const handleSelectFolder = React.useCallback(
    (folder: Project) => {
      setActiveFolderId(folder.id)
      try {
        window.localStorage.setItem(STORAGE_ACTIVE, folder.id)
      } catch {
        /* ignore */
      }
    },
    [],
  )

  const handleOpenInCode = React.useCallback(
    (folder: Project) => {
      handleSelectFolder(folder)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("siragpt:collapse-sidebar"))
      }
      router.push(`/code?folder=${encodeURIComponent(folder.id)}`)
      onMobileNavigate?.()
    },
    [handleSelectFolder, onMobileNavigate, router],
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
    if (window.location.pathname.startsWith("/code")) {
      window.dispatchEvent(new CustomEvent("siragpt:open-local-folder"))
      onMobileNavigate?.()
      return
    }
    toast.info("Abre Cursor y vuelve a pulsar + para seleccionar una carpeta del escritorio.")
    router.push("/code")
    onMobileNavigate?.()
  }, [onMobileNavigate, router])

  if (collapsed) return null

  return (
    <div className="px-1 pt-3">
      <div className="flex items-center gap-1 px-2 pb-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "group flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground",
          )}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <span>Carpetas</span>
          {folders.length > 0 ? (
            <span className="ml-1 rounded bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-tight text-muted-foreground">
              {folders.length}
            </span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={handleOpenDesktopFolder}
              aria-label="Abrir carpeta del escritorio"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Abrir carpeta del escritorio</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={() => refresh()}
              aria-label="Actualizar carpetas"
              disabled={loading}
            >
              {loading ? <ThinkingIndicator size="sm" className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Actualizar</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {open ? (
        loading && folders.length === 0 ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            <ThinkingIndicator size="sm" className="mx-auto mb-1 h-3.5 w-3.5 opacity-60" />
            Cargando…
          </div>
        ) : error ? (
          <div className="rounded-md border border-rose-300/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        ) : folders.length === 0 ? (
          null
        ) : (
          <div className="space-y-0.5 pb-1">
            {folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                expanded={expandedIds.has(folder.id)}
                isActive={activeFolderId === folder.id}
                state={chatsByFolder[folder.id]}
                onToggleExpanded={() => toggleExpanded(folder.id)}
                onSelectFolder={() => handleSelectFolder(folder)}
                onOpenInCode={() => handleOpenInCode(folder)}
                onOpenChat={handleOpenChat}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

function FolderRow({
  folder,
  expanded,
  isActive,
  state,
  onToggleExpanded,
  onSelectFolder,
  onOpenInCode,
  onOpenChat,
}: {
  folder: Project
  expanded: boolean
  isActive: boolean
  state: { loading: boolean; chats: ProjectChatSummary[]; error: string | null } | undefined
  onToggleExpanded: () => void
  onSelectFolder: () => void
  onOpenInCode: () => void
  onOpenChat: (chatId: string) => void
}) {
  return (
    <div
      className={cn(
        "rounded-md transition-colors",
        isActive ? "bg-accent/40" : "hover:bg-muted/30",
      )}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={expanded ? "Cerrar carpeta" : "Abrir carpeta"}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform duration-150", expanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={onSelectFolder}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={folder.name}
        >
          {isActive ? (
            <SquareCheck className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          ) : expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : (
            <FolderClosed className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              isActive ? "font-medium text-foreground" : "text-foreground/85",
            )}
          >
            {folder.name}
          </span>
          {typeof folder.chatCount === "number" ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">{folder.chatCount}</span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-6 w-6 shrink-0 text-muted-foreground hover:text-sky-500",
                isActive && "text-sky-500",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onOpenInCode()
              }}
              aria-label={`Abrir ${folder.name} en Cursor`}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Abrir en Cursor</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {expanded ? (
        <div className="ml-4 border-l border-border/40 pl-2">
          {state?.loading ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              <ThinkingIndicator size="xs" className="mr-1 inline opacity-70" />
              Cargando chats…
            </div>
          ) : state?.error ? (
            <div className="px-2 py-1.5 text-[11px] text-rose-500">{state.error}</div>
          ) : state?.chats?.length ? (
            <ul className="py-0.5">
              {state.chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    onClick={() => onOpenChat(chat.id)}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    title={chat.title}
                  >
                    <Square className="h-2.5 w-2.5 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground/80">Sin chats todavía.</div>
          )}
        </div>
      ) : null}
    </div>
  )
}
