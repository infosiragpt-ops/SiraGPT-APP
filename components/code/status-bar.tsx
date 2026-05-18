"use client"

import * as React from "react"
import { MessageSquare, TerminalSquare } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type StatusBarProps = {
  terminalOpen: boolean
  onToggleTerminal: () => void
  chatOpen: boolean
  onToggleChat: () => void
}

export function StatusBar({ terminalOpen, onToggleTerminal, chatOpen, onToggleChat }: StatusBarProps) {
  return (
    <footer
      className={cn(
        "flex h-6 shrink-0 items-center justify-between border-t border-border/60 bg-muted/25 px-2 text-[10px] text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">Workspace listo</span>
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-5 gap-1 px-1.5 text-[10px] font-normal",
            terminalOpen && "bg-muted/80 text-foreground",
          )}
          onClick={onToggleTerminal}
        >
          <TerminalSquare className="h-3 w-3" />
          Terminal
          <kbd className="ml-0.5 rounded bg-muted px-1 py-px text-[9px]">⌘J</kbd>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-5 gap-1 px-1.5 text-[10px] font-normal",
            chatOpen && "bg-muted/80 text-foreground",
          )}
          onClick={onToggleChat}
        >
          <MessageSquare className="h-3 w-3" />
          Chat
          <kbd className="ml-0.5 rounded bg-muted px-1 py-px text-[9px]">⌘L</kbd>
        </Button>
      </div>
    </footer>
  )
}
