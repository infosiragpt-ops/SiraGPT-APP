"use client"

/**
 * ToolsRail — 44px left dock for /code.
 * Common tools open as panes; "+" opens the All-tools popover.
 * This is a Sira rail (not the unused VS Code 6-icon ActivityBar).
 */

import * as React from "react"
import {
  Bot,
  FolderTree,
  GitBranch,
  KeyRound,
  Monitor,
  Plus,
  Rocket,
  Search,
  SquareTerminal,
  Terminal,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { WorkspaceToolId } from "@/lib/code-workspace-tools"

export type ToolsRailId = WorkspaceToolId | "all-tools"

type ToolsRailProps = {
  activeId?: ToolsRailId | null
  openToolIds?: WorkspaceToolId[]
  allToolsOpen?: boolean
  onSelect: (id: WorkspaceToolId) => void
  onOpenAllTools: () => void
}

const RAIL_ITEMS: { id: WorkspaceToolId; label: string; icon: React.ElementType }[] = [
  { id: "agent", label: "Agent", icon: Bot },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "shell", label: "Shell", icon: Terminal },
  { id: "console", label: "Console", icon: SquareTerminal },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "code-search", label: "Search", icon: Search },
  { id: "publishing", label: "Publishing", icon: Rocket },
  { id: "secrets", label: "Secrets", icon: KeyRound },
]

export function ToolsRail({
  activeId,
  openToolIds = [],
  allToolsOpen = false,
  onSelect,
  onOpenAllTools,
}: ToolsRailProps) {
  const openSet = React.useMemo(() => new Set(openToolIds), [openToolIds])

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className="sira-tools-rail hidden h-full w-11 shrink-0 flex-col items-center gap-0.5 border-r border-border/60 bg-muted/30 py-1 md:flex"
        style={{ width: 44 }}
        aria-label="Herramientas del workspace"
        data-sira-tools-rail="1"
        data-testid="sira-tools-rail"
      >
        {RAIL_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeId === id
          const opened = openSet.has(id)
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-pressed={active}
                  aria-label={label}
                  data-rail-tool={id}
                  className={cn(
                    "relative h-9 w-9 rounded-md",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                  )}
                  onClick={() => onSelect(id)}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                  {opened && !active ? (
                    <span
                      aria-hidden
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent-violet,262_83%_66%))]"
                    />
                  ) : null}
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
                aria-pressed={allToolsOpen}
                aria-label="Todas las herramientas"
                data-rail-tool="all-tools"
                className={cn(
                  "h-9 w-9 rounded-md",
                  allToolsOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
                onClick={onOpenAllTools}
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Todas las herramientas
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  )
}

/** Dead VS Code rail — kept so old imports do not crash. Prefer ToolsRail. */
export { ToolsRail as ActivityBar }
export type ActivityId = ToolsRailId
