"use client"

import * as React from "react"
import {
  CheckCircle2,
  FolderGit2,
  GitBranch,
  LayoutGrid,
  Monitor,
  Plus,
  Search,
  Terminal,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ProjectChip } from "./project-chip"

export type WorkspacePanelId = "preview" | "terminal" | "git" | "validation"

type PanelDef = {
  id: WorkspacePanelId
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const PANELS: PanelDef[] = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "terminal", label: "Shell", icon: Terminal },
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
  onOpenLauncher: () => void
  launcherOpen?: boolean
  onOpenCode: () => void
  codeOpen?: boolean
  toolsMenu?: React.ReactNode
}

export function WorkspaceTopBar({
  openPanels,
  activePanel,
  onTogglePanel,
  onClosePanel,
  onOpenPalette,
  onOpenSearch,
  onOpenLauncher,
  launcherOpen,
  onOpenCode,
  codeOpen,
  toolsMenu,
}: WorkspaceTopBarProps) {
  const visible = PANELS.filter((p) => openPanels.has(p.id))

  return (
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 bg-background/55 px-1.5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/40">
      {/* Left — editable project identity (sits above the chat column). */}
      <ProjectChip onOpenCode={onOpenCode} />
      <span className="h-4 w-px shrink-0 bg-border/50" />

      {/* Center — panel tabs + tools + search (sits above the preview). */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-0.5">
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
          aria-label="Herramientas del workspace"
          aria-pressed={launcherOpen}
          onClick={onOpenLauncher}
          className={cn(
            "h-7 rounded-md px-2 text-[11px] font-normal transition-colors",
            launcherOpen
              ? "bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))] shadow-[inset_0_0_0_1px_hsl(var(--accent-violet)/0.35)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <LayoutGrid className="mr-1 h-3 w-3" />
          Herramientas
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Código del proyecto"
          aria-pressed={codeOpen}
          onClick={onOpenCode}
          className={cn(
            "h-7 rounded-md px-2 text-[11px] font-normal transition-colors",
            codeOpen
              ? "bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))] shadow-[inset_0_0_0_1px_hsl(var(--accent-violet)/0.35)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <FolderGit2 className="mr-1 h-3 w-3" />
          Código
        </Button>
      </div>
    </header>
  )
}
