"use client"

import * as React from "react"
import { Loader2, Plus } from "lucide-react"
import { cn } from "@/lib/utils"

export type ChatSessionChipItem = {
  id: string
  title?: string | null
  updatedAt?: string | null
  activeTask?: { taskId?: string; status?: string } | null
}

function chipTitle(chat: ChatSessionChipItem): string {
  const raw = String(chat.title || "").replace(/\s+/g, " ").trim()
  return raw || "Nuevo chat"
}

export function ChatSessionChips({
  chats,
  currentChatId,
  runningChatIds,
  onSelect,
  onNewChat,
  className,
}: {
  chats: ChatSessionChipItem[]
  currentChatId?: string | null
  runningChatIds?: Iterable<string>
  onSelect: (chatId: string) => void
  onNewChat: () => void
  className?: string
}) {
  const running = React.useMemo(() => new Set(runningChatIds || []), [runningChatIds])
  const items = React.useMemo(() => {
    const seen = new Set<string>()
    const list: ChatSessionChipItem[] = []
    for (const chat of chats || []) {
      if (!chat?.id || seen.has(chat.id)) continue
      seen.add(chat.id)
      list.push(chat)
    }
    list.sort((a, b) => {
      const aRun = running.has(a.id) ? 1 : 0
      const bRun = running.has(b.id) ? 1 : 0
      if (aRun !== bRun) return bRun - aRun
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    })
    return list.slice(0, 10)
  }, [chats, running])

  // Hidden: conversation-pane title/# chips. Sidebar recents still show titles.
  return null
  if (!items.length && !currentChatId) {
    return (
      <div className={cn("chat-session-chips flex items-center gap-1.5 overflow-x-auto px-2 pb-1.5", className)}>
        <button
          type="button"
          onClick={onNewChat}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background px-3 text-xs font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          Nuevo chat
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "chat-session-chips flex items-center gap-1.5 overflow-x-auto px-2 pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      role="tablist"
      aria-label="Chats recientes"
    >
      <button
        type="button"
        onClick={onNewChat}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground"
        aria-label="Nuevo chat"
        title="Nuevo chat"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {items.map((chat) => {
        const active = chat.id === currentChatId
        const isRunning = running.has(chat.id) || Boolean(chat.activeTask)
        return (
          <button
            key={chat.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(chat.id)}
            className={cn(
              "inline-flex h-8 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs",
              active
                ? "border-primary/40 bg-primary/10 font-semibold text-foreground"
                : "border-border/50 bg-background text-muted-foreground",
            )}
            title={chipTitle(chat)}
          >
            {isRunning && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-label="Generando" />
            )}
            <span className="truncate">{chipTitle(chat)}</span>
          </button>
        )
      })}
    </div>
  )
}
