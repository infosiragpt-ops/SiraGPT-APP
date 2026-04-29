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
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
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
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Search Chats
          </DialogTitle>
        </DialogHeader>

        {/* Search Input */}
        <div className="px-6 pb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search chats"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>

        {/* Search Results */}
        <ScrollArea
          className="flex-1 max-h-[400px]"
          ref={scrollAreaRef}
          onScrollCapture={handleScroll}
        >
          <div className="px-6 pb-6">
            {searchResults.length === 0 && !isSearching ? (
              <div className="text-center py-8 text-muted-foreground">
                {searchQuery ? (
                  <>
                    <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No chats found matching "{searchQuery}"</p>
                    <p className="text-sm mt-1">Try different keywords</p>
                  </>
                ) : (
                  <>
                    <History className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No chats yet</p>
                    <p className="text-sm mt-1">Start a conversation to see it here</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1">

                {/* Chat results */}
                {searchResults.map((chat, index) => (
                  <Button
                    key={`${chat.id}-${index}`}
                    variant="ghost"
                    className="w-full justify-start p-3 h-auto text-left hover:bg-accent/50"
                    onClick={() => handleChatSelect(chat.id)}
                  >
                    <div className="flex items-start gap-3 w-full">
                      <div className="flex-shrink-0 mt-1">
                        <MessageCircle className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {searchQuery ? highlightSearchTerm(chat.title, searchQuery) : chat.title}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatChatTime(chat.updatedAt)}
                        </div>
                      </div>
                    </div>
                  </Button>
                ))}

                {/* Loading indicator for infinite scroll */}
                {isLoadingMore && !searchQuery && (
                  <div className="flex items-center justify-center py-4">
                    <ThinkingIndicator size="sm" className="mr-2" />
                    <span className="text-sm text-muted-foreground">Loading more chats...</span>
                  </div>
                )}

                {/* End of results indicator */}
                {!hasMoreChats && !searchQuery && searchResults.length > 10 && (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    You've reached the end of your chats
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}