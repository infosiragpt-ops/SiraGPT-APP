"use client"

import * as React from "react"
import {
  Search,
  History,
  MessageSquare,
  MessageCircle,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  X,
  List,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useChat } from "@/lib/chat-context-integrated"
import { apiClient } from "@/lib/api"
import { useTranslations } from "next-intl"
import { useRouter, usePathname } from "next/navigation"
import { isAgentsHomePath, agentsHomeHref } from "@/lib/agents-home-path"
import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { projectsService, type Project } from "@/lib/projects-service"
import { filterProjects } from "@/lib/projects-logic"

interface ChatSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SearchResult {
  id: string
  title: string
  updatedAt: string
  kind: "chat" | "project"
  messageCount?: number
  /** Present when the hit comes from server-side full-text search. */
  snippet?: string
  /** Present when the hit comes from server-side full-text search. */
  messageId?: string
}

type FullTextHit = NonNullable<
  Awaited<ReturnType<typeof apiClient.searchChats>>["results"]
>[number]

const SEARCH_LIMIT = 30
const PROJECT_LIMIT = 20

const DAY_MS = 24 * 60 * 60 * 1000

function formatRelativeChip(dateString: string): string {
  const date = new Date(dateString)
  const ts = date.getTime()
  if (!Number.isFinite(ts)) return ""
  const now = Date.now()
  const diffInMinutes = Math.max(0, Math.floor((now - ts) / (1000 * 60)))
  if (diffInMinutes < 60) return "Última hora"
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (ts >= startOfToday.getTime()) return "Hoy"
  if (ts >= startOfToday.getTime() - DAY_MS) return "Ayer"
  const diffInDays = Math.floor(diffInMinutes / (60 * 24))
  if (diffInDays < 30) return `hace ${diffInDays} d`
  return date.toLocaleDateString("es", { day: "numeric", month: "short" })
}

// The backend builds snippets with ts_headline using <mark>/</mark> and
// may include ellipses. Message content is user/model text that can
// contain angle brackets, so strip every tag except our highlight pair
// and escape the rest before the snippet is handed to
// dangerouslySetInnerHTML.
function sanitizeSnippetHtml(rawSnippet: string): string {
  const escaped = rawSnippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
  return escaped
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>")
}

function mapProjectResults(projects: Project[], query: string): SearchResult[] {
  return filterProjects(
    projects.filter((project) => project?.id && !project.deletedAt),
    query,
  )
    .slice(0, PROJECT_LIMIT)
    .map((project) => ({
      id: project.id,
      title: project.name || "Proyecto sin título",
      updatedAt: project.updatedAt || project.createdAt,
      kind: "project" as const,
    }))
}

function mergeSearchResults(
  chats: SearchResult[],
  projectItems: SearchResult[],
  mode: "rank" | "recency",
): SearchResult[] {
  if (mode === "rank") return [...chats, ...projectItems]
  return [...chats, ...projectItems].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
  )
}

export function ChatSearchDialog({ open, onOpenChange }: ChatSearchDialogProps) {
  const t = useTranslations("chatSearch")
  const [searchQuery, setSearchQuery] = React.useState("")
  const [debouncedQuery, setDebouncedQuery] = React.useState("")
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const {
    chats,
    selectChat,
    loadMoreChats,
    hasMoreChats,
    isLoadingMore,
  } = useChat()
  const router = useRouter()
  const pathname = usePathname()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement | null>>(new Map())
  const searchAbortRef = React.useRef<AbortController | null>(null)
  const [serverSearchFailed, setServerSearchFailed] = React.useState(false)
  const [projects, setProjects] = React.useState<Project[]>([])

  // Debounce search query
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 250)
    return () => clearTimeout(timer)
  }, [searchQuery])

  React.useEffect(() => {
    if (!open) {
      setProjects([])
      return
    }
    let cancelled = false
    projectsService
      .list({ sort: "activity" })
      .then((list) => {
        if (!cancelled) setProjects(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  React.useEffect(() => {
    return () => searchAbortRef.current?.abort()
  }, [])

  // Compute results for the debounced query. With a query we hit the
  // server-side full-text search (all history, ranked, with snippets);
  // without one we render the locally loaded recents as before. If the
  // backend search fails we fall back to the old title-only local filter
  // so the dialog degrades instead of showing a dead end.
  React.useEffect(() => {
    const query = debouncedQuery.trim()
    if (!query) {
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
      setServerSearchFailed(false)
      setSearchResults(
        mergeSearchResults(
          chats.filter((chat) => chat && chat.id).map((chat) => ({
            id: chat.id,
            title: chat.title || "Chat sin título",
            updatedAt: chat.updatedAt,
            kind: "chat" as const,
            messageCount: chat.messages?.length || 0,
          })),
          mapProjectResults(projects, ""),
          "recency",
        )
      )
      setIsSearching(false)
      return
    }

    const lowerQuery = query.toLowerCase()
    const localFallback = () =>
      chats
        .filter((chat) => chat && chat.id)
        .filter(
          (chat) =>
            chat.title?.toLowerCase().includes(lowerQuery) ||
            chat.id.toLowerCase().includes(lowerQuery)
        )
        .map((chat) => ({
          id: chat.id,
          title: chat.title || "Chat sin título",
          updatedAt: chat.updatedAt,
          kind: "chat" as const,
          messageCount: chat.messages?.length || 0,
        }))

    let cancelled = false
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller

    apiClient
      .searchChats(query, { limit: SEARCH_LIMIT, signal: controller.signal })
      .then((response) => {
        if (cancelled) return
        const hits: FullTextHit[] = Array.isArray(response?.results)
          ? response.results
          : []
        // Dedupe by chat: several messages of the same chat may match;
        // the dialog navigates to chats, so keep the best-ranked hit.
        const byChat = new Map<string, FullTextHit>()
        for (const hit of hits) {
          if (hit?.chatId && !byChat.has(hit.chatId)) byChat.set(hit.chatId, hit)
        }
        setSearchResults(
          mergeSearchResults(
            Array.from(byChat.values()).map((hit) => ({
              id: hit.chatId,
              title: hit.chatTitle || "Chat sin título",
              updatedAt: hit.timestamp,
              kind: "chat" as const,
              snippet: hit.snippet || "",
              messageId: hit.messageId,
            })),
            mapProjectResults(projects, query),
            "rank",
          )
        )
        setServerSearchFailed(false)
        setIsSearching(false)
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return
        console.error("Full-text chat search failed; falling back to local titles:", error)
        setSearchResults(mergeSearchResults(localFallback(), mapProjectResults(projects, query), "rank"))
        setServerSearchFailed(true)
        setIsSearching(false)
      })

    return () => {
      cancelled = true
    }
  }, [debouncedQuery, chats, projects])

  // While the user is typing (query differs from the settled debounced value)
  // show the inline spinner so the input feels responsive.
  React.useEffect(() => {
    if (searchQuery.trim() && searchQuery !== debouncedQuery) setIsSearching(true)
    else setIsSearching(false)
  }, [searchQuery, debouncedQuery])

  // Reset keyboard cursor whenever the result set or query changes.
  React.useEffect(() => {
    setActiveIndex(0)
  }, [debouncedQuery, open])

  React.useEffect(() => {
    if (activeIndex > searchResults.length - 1) setActiveIndex(0)
  }, [searchResults.length, activeIndex])

  // Keep the active item visible during keyboard navigation.
  React.useEffect(() => {
    const el = itemRefs.current.get(activeIndex)
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, searchResults])

  // Infinite scroll handler for recent chats (only when not actively searching).
  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (debouncedQuery.trim()) return
      const target = e.target as HTMLDivElement
      const nearBottom =
        target.scrollHeight - target.scrollTop - target.clientHeight < 48
      if (nearBottom && hasMoreChats && !isLoadingMore) loadMoreChats()
    },
    [debouncedQuery, hasMoreChats, isLoadingMore, loadMoreChats]
  )

  const handleChatSelect = React.useCallback(
    (item: SearchResult) => {
      if (item.kind === "project") {
        router.push(`/projects/${item.id}`)
        onOpenChange(false)
        setSearchQuery("")
        return
      }
      selectChat(item.id)
      if (!isAgentsHomePath(pathname)) {
        router.push(agentsHomeHref(`id=${item.id}`))
      }
      onOpenChange(false)
      setSearchQuery("")
    },
    [selectChat, pathname, router, onOpenChange]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => (searchResults.length ? Math.min(i + 1, searchResults.length - 1) : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const chat = searchResults[activeIndex]
      if (chat) handleChatSelect(chat)
    }
  }

  const highlightSearchTerm = (text: string, query: string) => {
    if (!query) return text
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
    const parts = text.split(regex)
    return parts.map((part, index) =>
      regex.test(part) ? (
        <mark
          key={index}
          className="rounded-[3px] bg-primary/15 px-0.5 font-semibold text-foreground"
        >
          {part}
        </mark>
      ) : (
        <React.Fragment key={index}>{part}</React.Fragment>
      )
    )
  }

  React.useEffect(() => {
    if (!open) setSearchQuery("")
  }, [open])

  const resultCount = searchResults.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-chat-search-dialog="1"
        overlayClassName="bg-black/50"
        className="flex max-h-[min(72vh,640px)] w-[min(100vw-2rem,560px)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 bg-white p-0 text-zinc-900 shadow-[0_24px_80px_-20px_rgba(15,23,42,0.35)] dark:border-zinc-800/80 dark:bg-[#0E131B] dark:text-zinc-100 dark:shadow-[0_24px_80px_-20px_rgba(0,0,0,0.75)] sm:max-w-[560px]"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-zinc-200/80 bg-white px-4 py-3 text-zinc-900 dark:border-zinc-800/80 dark:bg-[#0E131B] dark:text-zinc-100">
          <DialogTitle className="sr-only">Buscar chats y proyectos</DialogTitle>
          <div className="flex items-center gap-3">
            <Search className="h-[18px] w-[18px] shrink-0 text-zinc-400 dark:text-zinc-500" />
            <Input
              ref={inputRef}
              placeholder="Buscar chats y proyectos"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-9 flex-1 border-0 bg-transparent px-0 text-[15px] text-zinc-900 shadow-none placeholder:text-zinc-400 focus-visible:ring-0 focus-visible:ring-offset-0 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              autoFocus
            />
            {isSearching ? (
              <ThinkingIndicator size="sm" className="text-zinc-400 dark:text-zinc-500" />
            ) : null}
            <button
              type="button"
              aria-label="Cerrar"
              data-chat-search-close="1"
              onClick={() => onOpenChange(false)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white dark:bg-[#0E131B]" onScroll={handleScroll}>
          <div className="px-2 py-2">
            {resultCount === 0 && !isSearching ? (
              <div className="flex flex-col items-center justify-center px-6 py-14 text-center text-zinc-500 dark:text-zinc-400">
                {searchQuery ? (
                  <>
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800/50">
                      <MessageSquare className="h-5 w-5 opacity-70" />
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("noResults")}</p>
                    <p className="mt-1 text-xs">
                      {serverSearchFailed
                        ? t("serverFallback")
                        : t("noResultsFor", { query: searchQuery })}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800/50">
                      <History className="h-5 w-5 opacity-70" />
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("emptyHistory")}</p>
                    <p className="mt-1 text-xs">{t("emptyHistoryHint")}</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((chat, flatIndex) => {
                  const isActive = flatIndex === activeIndex
                  const isProject = chat.kind === "project"
                  return (
                    <button
                      key={`${chat.kind}:${chat.id}`}
                      type="button"
                      ref={(el) => {
                        itemRefs.current.set(flatIndex, el)
                      }}
                      onMouseMove={() => setActiveIndex(flatIndex)}
                      onClick={() => handleChatSelect(chat)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                        isActive
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800/60 dark:text-zinc-100"
                          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/30",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200/60 bg-zinc-50 transition-colors dark:border-zinc-800/50 dark:bg-zinc-800/40",
                          isActive && "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
                        )}
                      >
                        {isProject ? (
                          <List className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                        ) : (
                          <MessageCircle className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-50">
                          {searchQuery
                            ? highlightSearchTerm(chat.title, searchQuery)
                            : chat.title}
                        </div>
                        {chat.snippet ? (
                          <div
                            className="mt-0.5 line-clamp-2 text-xs leading-snug text-zinc-500 dark:text-zinc-400 [&_mark]:rounded-[3px] [&_mark]:bg-primary/15 [&_mark]:px-0.5 [&_mark]:font-semibold [&_mark]:text-foreground"
                            dangerouslySetInnerHTML={{ __html: sanitizeSnippetHtml(chat.snippet) }}
                          />
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
                        {formatRelativeChip(chat.updatedAt)}
                      </span>
                      <CornerDownLeft
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-zinc-400 transition-opacity dark:text-zinc-500",
                          isActive ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </button>
                  )
                })}

                {isLoadingMore && !searchQuery && (
                  <div className="flex items-center justify-center gap-2 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                    <ThinkingIndicator size="sm" />
                    <span>Cargando más chats…</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-zinc-200/80 bg-white px-4 py-2 text-[11px] text-zinc-400 dark:border-zinc-800/80 dark:bg-[#0E131B] dark:text-zinc-500">
          <span className="tabular-nums">
            {resultCount > 0
              ? resultCount === 1
                ? "1 resultado"
                : `${resultCount} resultados`
              : ""}
          </span>
          <div className="hidden items-center gap-3 sm:flex">
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40">
                <ArrowUp className="h-2.5 w-2.5" />
              </kbd>
              <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40">
                <ArrowDown className="h-2.5 w-2.5" />
              </kbd>
              navegar
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 items-center justify-center rounded border border-zinc-200 bg-zinc-50 px-1 dark:border-zinc-800 dark:bg-zinc-800/40">
                <CornerDownLeft className="h-2.5 w-2.5" />
              </kbd>
              abrir
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 items-center justify-center rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[9px] dark:border-zinc-800 dark:bg-zinc-800/40">
                esc
              </kbd>
              cerrar
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
