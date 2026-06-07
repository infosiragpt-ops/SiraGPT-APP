"use client"

import * as React from "react"
import { Search, History, Clock, MessageSquare, Loader2, MessageCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useChat } from "@/lib/chat-context-integrated"
import { useRouter, usePathname } from "next/navigation"

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

export function ChatSearchDialog({ open, onOpenChange }: ChatSearchDialogProps) {
  const [searchQuery, setSearchQuery] = React.useState("")
  const [debouncedQuery, setDebouncedQuery] = React.useState("")
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const {
    chats,
    selectChat,
    loadMoreChats,
    hasMoreChats,
    isLoadingMore
  } = useChat()
  const router = useRouter()
  const pathname = usePathname()
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)

  // Debounce search query
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 300) // 300ms debounce

    return () => clearTimeout(timer)
  }, [searchQuery])

  // Initialize search results with all chats when dialog opens
  React.useEffect(() => {
    if (open && chats.length > 0) {
      const loadedChats = chats.map(chat => ({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages?.length || 0
      }))
      setSearchResults(loadedChats)
    }
  }, [open, chats])

  // Perform search when debounced query changes
  React.useEffect(() => {
    const performSearch = async () => {
      if (!debouncedQuery.trim()) {
        // Show all currently loaded chats (supports infinite scroll)
        const loadedChats = chats.filter(chat => chat && chat.id).map(chat => ({
          id: chat.id,
          title: chat.title,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages?.length || 0
        }))
        setSearchResults(loadedChats)
        setIsSearching(false)
        return
      }

      setIsSearching(true)

      // Filter chats by title OR id
      const filteredChats = chats
        .filter(chat =>
          chat.title.toLowerCase().includes(debouncedQuery.toLowerCase()) ||
          chat.id.toLowerCase().includes(debouncedQuery.toLowerCase())
        )
        .map(chat => ({
          id: chat.id,
          title: chat.title,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages?.length || 0
        }))

      setSearchResults(filteredChats)
      setIsSearching(false)
    }

    performSearch()
  }, [debouncedQuery, chats])

  // Infinite scroll handler for recent chats (when no search)
  const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (debouncedQuery.trim()) return // Don't load more during search

    const target = e.target as HTMLDivElement
    const bottom = target.scrollHeight - target.scrollTop === target.clientHeight

    if (bottom && hasMoreChats && !isLoadingMore) {
      loadMoreChats()
    }
  }, [debouncedQuery, hasMoreChats, isLoadingMore, loadMoreChats])

  const handleChatSelect = (chatId: string) => {
    selectChat(chatId)
    // Navigate to chat if not already there
    if (!pathname.startsWith('/chat')) {
      router.push(`/chat?id=${chatId}`)
    }
    onOpenChange(false) // Close dialog
    setSearchQuery("") // Clear search
  }

  const formatChatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInMinutes = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60)
    )

    if (diffInMinutes < 1) return "Just now"
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`
    const diffInHours = Math.floor(diffInMinutes / 60)
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return "Yesterday"
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  const highlightSearchTerm = (text: string, query: string) => {
    if (!query) return text

    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(regex)

    return parts.map((part, index) => (
      regex.test(part) ? (
        <span key={index} className="bg-yellow-200 dark:bg-yellow-900 text-yellow-900 dark:text-yellow-100 rounded px-1">
          {part}
        </span>
      ) : (
        part
      )
    ))
  }

  // Reset search when dialog closes but don't clear results immediately
  React.useEffect(() => {
    if (!open) {
      setSearchQuery("")
      // Don't clear searchResults here - let them persist for next open
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="top-start" className="flex max-h-[70vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px] bg-white dark:bg-[#0E131B] border-zinc-200 dark:border-zinc-800/80 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.55)] dark:shadow-[0_24px_70px_-36px_rgba(0,0,0,0.8)] text-zinc-900 dark:text-zinc-100">
        <DialogHeader className="shrink-0 space-y-0 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-[#0E131B] px-4 py-3 text-zinc-900 dark:text-zinc-100">
          <DialogTitle className="sr-only">Buscar chats</DialogTitle>
          <div className="flex items-center gap-3">
            <Search className="h-[18px] w-[18px] shrink-0 text-zinc-400 dark:text-zinc-500" />
            <Input
              placeholder="Buscar en tus chats…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 flex-1 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400 dark:text-zinc-500" />
            )}
            {!isSearching && !searchQuery && (
              <kbd className="hidden shrink-0 items-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500 sm:inline-flex">
                ⌘K
              </kbd>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white dark:bg-[#0E131B]" onScrollCapture={handleScroll}>
          <div className="px-4 py-2">
            {searchResults.length === 0 && !isSearching ? (
              <div className="text-center py-8 text-zinc-500 dark:text-zinc-400">
                {searchQuery ? (
                  <>
                    <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-50 text-zinc-400 dark:text-zinc-500" />
                    <p className="text-zinc-900 dark:text-zinc-100 font-medium">No hay chats que coincidan con &quot;{searchQuery}&quot;</p>
                    <p className="text-sm mt-1">Intenta con otras palabras clave</p>
                  </>
                ) : (
                  <>
                    <History className="h-12 w-12 mx-auto mb-3 opacity-50 text-zinc-400 dark:text-zinc-500" />
                    <p className="text-zinc-900 dark:text-zinc-100 font-medium">Aún no tienes chats</p>
                    <p className="text-sm mt-1">Empieza una conversación para verla aquí</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1">

                {/* Chat results */}
                {searchResults.map((chat, index) => (
                  <button
                    key={`${chat.id}-${index}`}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
                    onClick={() => handleChatSelect(chat.id)}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200/50 dark:border-zinc-800/50 bg-zinc-50 dark:bg-zinc-800/40">
                      <MessageCircle className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-50">
                        {searchQuery ? highlightSearchTerm(chat.title, searchQuery) : chat.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatChatTime(chat.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}

                {/* Loading indicator for infinite scroll */}
                {isLoadingMore && !searchQuery && (
                  <div className="flex items-center justify-center py-4 text-zinc-500 dark:text-zinc-400">
                    <ThinkingIndicator size="sm" className="mr-2" />
                    <span className="text-sm">Loading more chats...</span>
                  </div>
                )}

                {/* End of results indicator */}
                {!hasMoreChats && !searchQuery && searchResults.length > 10 && (
                  <div className="text-center py-4 text-xs text-zinc-400 dark:text-zinc-500">
                    You've reached the end of your chats
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}