"use client"

import * as React from "react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"
import { useBackgroundStreams } from "@/lib/background-streams-context"
import { useChatList } from "@/lib/chat-context-integrated"
import apiClient, { shouldDetachAgentTaskRecovery, shouldStopPendingStreamRecovery } from "@/lib/api"
import { postMobileStopStream } from "@/lib/mobile-stop-stream"

export function RunningChatsBar({
  currentChatId,
  onSelectChat,
}: {
  currentChatId?: string | null
  onSelectChat: (chatId: string) => void
}) {
  const bg = useBackgroundStreams()
  const { chats } = useChatList()
  const rememberEventId = bg.rememberEventId
  const resumeFailures = React.useRef(0)

  // FE-037: reconnect via pending-stream on mount. Bar layout stays locked
  // (this component still returns null — do not move the bar).
  React.useEffect(() => {
    let cancelled = false
    const resume = async () => {
      if (shouldStopPendingStreamRecovery(resumeFailures.current)) return
      const ids = new Set<string>()
      if (currentChatId) ids.add(String(currentChatId))
      try {
        const active = await apiClient.getActiveChatRuns()
        for (const run of active?.runs || []) {
          const id = (run as { chatId?: string })?.chatId
          if (id) ids.add(String(id))
        }
      } catch {
        resumeFailures.current += 1
      }
      for (const id of ids) {
        if (cancelled) return
        if (shouldStopPendingStreamRecovery(resumeFailures.current)) return
        try {
          const envelope = await apiClient.getChatPendingStream(id)
          if (!envelope?.ok) {
            resumeFailures.current += 1
            continue
          }
          resumeFailures.current = 0
          const pending = envelope.pending as { lastEventId?: string; id?: string; eventId?: string } | null
          const lastId = pending && (pending.lastEventId || pending.id || pending.eventId)
          if (lastId) rememberEventId(id, String(lastId))
        } catch {
          resumeFailures.current += 1
        }
      }
    }
    void resume()
    return () => { cancelled = true }
  }, [currentChatId, rememberEventId])

  const running = React.useMemo(() => {
    const items: Array<{ id: string; title: string }> = []
    const seen = new Set<string>()
    for (const stream of bg.streams.values()) {
      if (stream.status !== "streaming") continue
      if (seen.has(stream.chatId)) continue
      seen.add(stream.chatId)
      const chat = (chats || []).find((c: any) => c?.id === stream.chatId)
      items.push({
        id: stream.chatId,
        title: String(chat?.title || stream.title || "Chat").slice(0, 36),
      })
    }
    return items
  }, [bg.streams, chats])

  // Hidden: title pill in the conversation pane was noisy.
  return null
  if (running.length === 0) return null

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-2 py-1"
      role="list"
      aria-label="Chats en segundo plano"
    >
      {running.map((chat) => {
        const active = chat.id === currentChatId
        return (
          <button
            key={chat.id}
            type="button"
            role="listitem"
            onClick={() => onSelectChat(chat.id)}
            title={active ? "Este chat sigue generando" : "Volver a este chat"}
            className={cn(
              "inline-flex max-w-[14rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              active
                ? "border-sky-400/70 bg-sky-500/10 text-foreground"
                : "border-border/70 bg-background/80 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            <ThinkingIndicator size="xs" label="Generando" className="text-sky-500" />
            <span className="truncate">{chat.title}</span>
          </button>
        )
      })}
    </div>
  )
}
