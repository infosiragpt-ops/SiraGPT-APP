"use client"

import * as React from "react"
import {
  FolderTree,
  GitBranch,
  MessageSquare,
  Play,
  Puzzle,
  Search,
  Sparkles,
  Settings,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type ActivityId = "files" | "search" | "scm" | "run" | "extensions" | "settings"

type ActivityBarProps = {
  activity: ActivityId
  onActivityChange: (id: ActivityId) => void
  chatOpen: boolean
  onToggleChat: () => void
  onComposer: () => void
}

const ITEMS: { id: ActivityId; label: string; icon: React.ElementType }[] = [
  { id: "files", label: "Explorador", icon: FolderTree },
  { id: "search", label: "Buscar", icon: Search },
  { id: "scm", label: "Control de origen", icon: GitBranch },
  { id: "run", label: "Ejecutar", icon: Play },
  { id: "extensions", label: "Extensiones", icon: Puzzle },
  { id: "settings", label: "Ajustes", icon: Settings },
]

export function ActivityBar({
  activity,
  onActivityChange,
  chatOpen,
  onToggleChat,
  onComposer,
}: ActivityBarProps) {
  return (
    <TooltipProvider delayDuration={250}>
      <nav
        className={cn(
          "flex h-full w-11 shrink-0 flex-col items-center gap-0.5 border-r border-border/60 bg-muted/30 py-1",
        )}
        aria-label="Actividades del workspace"
      >
        {ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activity === id
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-pressed={active}
                  className={cn(
                    "h-9 w-9 rounded-md",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                  )}
                  onClick={() => onActivityChange(id)}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                  <span className="sr-only">{label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {label}
              </TooltipContent>
            </Tooltip>
          )
        })}

        <div className="mt-auto flex flex-col gap-0.5 pb-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={chatOpen}
                className={cn(
                  "h-9 w-9 rounded-md",
                  chatOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
                onClick={onToggleChat}
              >
                <MessageSquare className="h-4 w-4" strokeWidth={1.75} />
                <span className="sr-only">Alternar chat</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Cursor Chat · ⌘L
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-md text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                onClick={onComposer}
              >
                <Sparkles className="h-4 w-4" strokeWidth={1.75} />
                <span className="sr-only">Composer</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Composer · ⌘I
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  )
}
