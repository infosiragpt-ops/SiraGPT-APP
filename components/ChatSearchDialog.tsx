"use client"

import * as React from "react"
import {
  Search,
  History,
  Clock,
  MessageSquare,
  Loader2,
  MessageCircle,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useChat } from "@/lib/chat-context-integrated"
import { useRouter, usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

interface ChatSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SearchResult {
  id: string
  title: string
  updatedAt: string
  messageCount?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

// Date bucket order matches the sidebar's ChatGPT/Claude-style grouping so the
// search results feel consistent with the rest of the app.
const BUCKET_ORDER = ["Hoy", "Ayer", "Últimos 7 días", "Anteriores"] as const
type BucketLabel = (typeof BUCKET_ORDER)[number]

function bucketFor(updatedAt: string): BucketLabel {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - DAY_MS
  const weekAgo = Date.now() - 7 * DAY_MS
  const ts = new Date(updatedAt).getTime()
  if (!Number.isFinite(ts)) return "Anteriores"
  if (ts >= startOfToday) return "Hoy"
  if (ts >= startOfYesterday) return "Ayer"
  if (ts >= weekAgo) return "Últimos 7 días"
  return "Anteriores"
}

function formatChatTime(dateString: string): string {
  const date = new Date(dateString)
  const ts = date.getTime()
  if (!Number.isFinite(ts)) return ""
  const diffInMinutes = Math.max(0, Math.floor((Date.now() - ts) / (1000 * 60)))

  if (diffInMinutes < 1) return "Ahora"
  if (diffInMinutes < 60) return `hace ${diffInMinutes} min`
  const diffInHours = Math.floor(diffInMinutes / 60)
  if (diffInHours < 24) return `hace ${diffInHours} h`
  if (diffInHours < 48) return "Ayer"
  const diffInDays = Math.floor(diffInHours / 24)
  if (diffInDays < 30) return `hace ${diffInDays} d`
  return date.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })
}

export function ChatSearchDialog({ open, onOpenChange }: ChatSearchDialogProps) {
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

  // Debounce search query
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Compute results from loaded chats, filtered by the debounced query.
  React.useEffect(() => {
    const query = debouncedQuery.trim().toLowerCase()
    const source = chats.filter((chat) => chat && chat.id)

    const matched = (query
      ? source.filter(
          (chat) =>
            chat.title?.toLowerCase().includes(query) ||
            chat.id.toLowerCase().includes(query)
        )
      : source
    ).map((chat) => ({
      id: chat.id,
      title: chat.title || "Chat sin título",
      updatedAt: chat.updatedAt,
      messageCount: chat.messages?.length || 0,
    }))

    setSearchResults(matched)
    setIsSearching(false)
  }, [debouncedQuery, chats])

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

  // Group results into date buckets while preserving the flat index used for
  // keyboard navigation.
  const groups = React.useMemo(() => {
    const map = new Map<BucketLabel, { result: SearchResult; flatIndex: number }[]>()
    searchResults.forEach((result, flatIndex) => {
      const label = bucketFor(result.updatedAt)
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push({ result, flatIndex })
    })
    return BUCKET_ORDER.filter((label) => map.has(label)).map((label) => ({
      label,
      items: map.get(label)!,
    }))
  }, [searchResults])

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
    (chatId: string) => {
      selectChat(chatId)
      if (!pathname.startsWith("/chat")) {
        router.push(`/chat?id=${chatId}`)
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
      if (chat) handleChatSelect(chat.id)
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
        position="top-start"
        className="flex max-h-[70vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px] bg-white dark:bg-[#0E131B] border-zinc-200 dark:border-zinc-800/80 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.55)] dark:shadow-[0_24px_70px_-36px_rgba(0,0,0,0.8)] text-zinc-900 dark:text-zinc-100"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-[#0E131B] px-4 py-3 text-zinc-900 dark:text-zinc-100">
          <DialogTitle className="sr-only">Buscar chats</DialogTitle>
          <div className="flex items-center gap-3">
            <Search className="h-[18px] w-[18px] shrink-0 text-zinc-400 dark:text-zinc-500" />
            <Input
              ref={inputRef}
              placeholder="Buscar en tus chats…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-9 flex-1 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              autoFocus
            />
            {isSearching ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400 dark:text-zinc-500" />
            ) : searchQuery ? (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                onClick={() => {
                  setSearchQuery("")
                  inputRef.current?.focus()
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 dark:text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            ) : (
              <kbd className="hidden shrink-0 items-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500 sm:inline-flex">
                ⌘K
              </kbd>
            )}
          </div>
        </DialogHeader>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white dark:bg-[#0E131B]" onScroll={handleScroll}>
          <div className="px-2 py-2">
            {resultCount === 0 && !isSearching ? (
              <div className="flex flex-col items-center justify-center px-6 py-14 text-center text-zinc-500 dark:text-zinc-400">
                {searchQuery ? (
                  <>
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800/50">
                      <MessageSquare className="h-5 w-5 opacity-70" />
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Sin resultados</p>
                    <p className="mt-1 text-xs">
                      No encontramos chats para «{searchQuery}»
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800/50">
                      <History className="h-5 w-5 opacity-70" />
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Aún no tienes chats</p>
                    <p className="mt-1 text-xs">Empieza una conversación para verla aquí</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.label}>
                    <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      {group.label}
                    </div>
                    <div className="space-y-0.5">
                      {group.items.map(({ result: chat, flatIndex }) => {
                        const isActive = flatIndex === activeIndex
                        return (
                          <button
                            key={chat.id}
                            type="button"
                            ref={(el) => {
                              itemRefs.current.set(flatIndex, el)
                            }}
                            onMouseMove={() => setActiveIndex(flatIndex)}
                            onClick={() => handleChatSelect(chat.id)}
                            className={cn(
                              "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                              isActive
                                ? "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100"
                                : "hover:bg-zinc-50 dark:hover:bg-zinc-800/30 text-zinc-700 dark:text-zinc-300"
                            )}
                          >
                            <div
                              className={cn(
                                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200/50 dark:border-zinc-800/50 bg-zinc-50 dark:bg-zinc-800/40 transition-colors",
                                isActive && "border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                              )}
                            >
                              <MessageCircle className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-50">
                                {searchQuery
                                  ? highlightSearchTerm(chat.title, searchQuery)
                                  : chat.title}
                              </div>
                              <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                                <span className="inline-flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {formatChatTime(chat.updatedAt)}
                                </span>
                                {chat.messageCount ? (
                                  <>
                                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                                    <span className="inline-flex items-center gap-1">
                                      <MessageSquare className="h-3 w-3" />
                                      {chat.messageCount}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <CornerDownLeft
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500 transition-opacity",
                                isActive ? "opacity-100" : "opacity-0"
                              )}
                            />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}

                {isLoadingMore && !searchQuery && (
                  <div className="flex items-center justify-center gap-2 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                    <ThinkingIndicator size="sm" />
                    <span>Cargando más chats…</span>
                  </div>
                )}

                {!hasMoreChats && !searchQuery && resultCount > 10 && (
                  <div className="py-3 text-center text-xs text-zinc-400 dark:text-zinc-500">
                    Has llegado al final de tus chats
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer with keyboard hints */}
        <div className="flex shrink-0 items-center justify-between border-t border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-[#0E131B] px-4 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span className="tabular-nums">
            {resultCount > 0
              ? `${resultCount} ${resultCount === 1 ? "chat" : "chats"}`
              : ""}
          </span>
          <div className="hidden items-center gap-3 sm:flex">
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
                <ArrowUp className="h-2.5 w-2.5" />
              </kbd>
              <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
                <ArrowDown className="h-2.5 w-2.5" />
              </kbd>
              navegar
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 items-center justify-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 px-1">
                <CornerDownLeft className="h-2.5 w-2.5" />
              </kbd>
              abrir
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex h-4 items-center justify-center rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 px-1 font-mono text-[9px]">
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
