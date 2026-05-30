"use client"

import * as React from "react"
import {
  CheckCircle2,
  GitBranch,
  Globe,
  Monitor,
  Plus,
  Search,
  Terminal,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type WorkspacePanelId = "preview" | "terminal" | "git" | "validation"

type PanelDef = {
  id: WorkspacePanelId
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const PANELS: PanelDef[] = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "validation", label: "Validation", icon: CheckCircle2 },
]

export type WorkspaceTopBarProps = {
  openPanels: Set<WorkspacePanelId>
  activePanel: WorkspacePanelId | null
  onTogglePanel: (id: WorkspacePanelId) => void
  onClosePanel: (id: WorkspacePanelId) => void
  onOpenPalette: (query?: string) => void
  onOpenSearch: () => void
  toolsMenu?: React.ReactNode
}

export function WorkspaceTopBar({
  openPanels,
  activePanel,
  onTogglePanel,
  onClosePanel,
  onOpenPalette,
  onOpenSearch,
  toolsMenu,
}: WorkspaceTopBarProps) {
  const visible = PANELS.filter((p) => openPanels.has(p.id))

  return (
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 bg-background/55 px-1.5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/40">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {visible.map((panel) => {
          const Icon = panel.icon
          const active = activePanel === panel.id
          return (
            <div
              key={panel.id}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] text-muted-foreground transition-colors",
                active && "border-border/60 bg-background text-foreground shadow-sm",
                !active && "hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1"
                onClick={() => onTogglePanel(panel.id)}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", active && panel.id === "preview" && "text-emerald-600")} />
                <span className="truncate">{panel.label}</span>
              </button>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                aria-label={`Cerrar ${panel.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClosePanel(panel.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {toolsMenu ?? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md text-muted-foreground"
            aria-label="Herramientas y archivos"
            onClick={() => onOpenPalette()}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground"
          aria-label="Buscar"
          onClick={onOpenSearch}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 pl-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-md px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (typeof window !== "undefined") window.open("/", "_blank", "noopener,noreferrer")
          }}
        >
          <Globe className="mr-1 h-3 w-3" />
          App
        </Button>
      </div>
    </header>
  )
}
