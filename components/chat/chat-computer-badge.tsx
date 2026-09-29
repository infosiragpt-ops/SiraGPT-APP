"use client"

import { Laptop } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * claude.ai-style computer mark before the chat title (top-left of /agentes):
 * the laptop stands for this chat's computer, a pulsing dot says the agent is
 * working in it right now, and a click opens the Computadora panel.
 */
export function ChatComputerBadge({
  working = false,
  active = false,
  onOpen,
  className,
}: {
  working?: boolean
  active?: boolean
  onOpen?: () => void
  className?: string
}) {
  const label = working ? "Computadora de este chat · trabajando" : "Computadora de este chat"
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={label}
            aria-pressed={active}
            data-active={active ? "true" : "false"}
            data-working={working ? "true" : "false"}
            data-testid="chat-computer-badge"
            className={cn(
              "chat-computer-badge relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
              "text-muted-foreground transition-colors duration-150",
              "hover:bg-muted/70 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "data-[active=true]:bg-muted data-[active=true]:text-foreground",
              "data-[working=true]:text-foreground",
              className,
            )}
          >
            <Laptop aria-hidden="true" className="h-[17px] w-[17px]" strokeWidth={1.75} />
            {working ? (
              <span aria-hidden="true" className="pointer-events-none absolute right-[5px] top-[5px] flex h-[7px] w-[7px]">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/35 motion-reduce:animate-none" />
                <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-foreground ring-2 ring-background" />
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="text-[12px]">
          {working ? "Trabajando en la computadora de este chat" : "Abrir la computadora de este chat"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default ChatComputerBadge
