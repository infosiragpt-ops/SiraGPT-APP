"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { useChatList } from "@/lib/chat-context-integrated"
import {
  goAgentsHistory,
  recordAgentsVisit,
  snapshotAgentsHistory,
  subscribeAgentsHistory,
} from "@/lib/agents-session-history"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const ARROW_BTN = cn(
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
  "text-zinc-500 transition-colors duration-150",
  "hover:bg-zinc-950/[0.06] hover:text-zinc-900",
  "disabled:pointer-events-none disabled:opacity-30",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50",
  "dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-50",
)

function HistoryArrowButton({
  label,
  disabled,
  onClick,
  testId,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={onClick}
          className={ARROW_BTN}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="rounded-lg border-0 bg-zinc-950 px-2.5 py-1.5 text-[12px] font-medium text-white"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentsHistoryNav({ className }: { className?: string }) {
  const { currentChatId, selectChat, setCurrentChat } = useChatList()
  const skipRecordRef = React.useRef(false)
  const snapshot = React.useSyncExternalStore(
    subscribeAgentsHistory,
    snapshotAgentsHistory,
    snapshotAgentsHistory,
  )

  React.useEffect(() => {
    if (skipRecordRef.current) {
      skipRecordRef.current = false
      return
    }
    recordAgentsVisit(currentChatId ?? null)
  }, [currentChatId])

  const applyVisit = React.useCallback((chatId: string | null) => {
    skipRecordRef.current = true
    if (!chatId) {
      setCurrentChat(null)
      try {
        localStorage.removeItem("currentChatId")
      } catch {
        /* private mode */
      }
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("resetChatState"))
      }, 0)
      return
    }
    selectChat(chatId)
  }, [selectChat, setCurrentChat])

  const goBack = React.useCallback(() => {
    const target = goAgentsHistory(-1)
    if (target === null) return
    applyVisit(target || null)
  }, [applyVisit])

  const goForward = React.useCallback(() => {
    const target = goAgentsHistory(1)
    if (target === null) return
    applyVisit(target || null)
  }, [applyVisit])

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={cn("flex shrink-0 items-center", className)}
        data-testid="agents-history-nav"
        role="group"
        aria-label="Historial de agentes"
      >
        <HistoryArrowButton
          label="Atrás"
          disabled={!snapshot.canBack}
          onClick={goBack}
          testId="agents-history-back"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.9} />
        </HistoryArrowButton>
        <HistoryArrowButton
          label="Adelante"
          disabled={!snapshot.canForward}
          onClick={goForward}
          testId="agents-history-forward"
        >
          <ArrowRight className="h-4 w-4" strokeWidth={1.9} />
        </HistoryArrowButton>
      </div>
    </TooltipProvider>
  )
}
