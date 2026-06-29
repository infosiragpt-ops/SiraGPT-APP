"use client"

import * as React from "react"
import {
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Monitor,
  Plus,
  Search,
  Terminal,
  UserPlus,
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
  onOpenInvite: () => void
  inviteOpen?: boolean
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
  onOpenInvite,
  inviteOpen,
  onOpenCode,
  codeOpen,
  toolsMenu,
}: WorkspaceTopBarProps) {
  const visible = PANELS.filter((p) => openPanels.has(p.id))

  return (
    <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background/85 px-2 shadow-[0_1px_0_rgba(15,23,42,0.03)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
      {/* Left — editable project identity (sits above the chat column). */}
      <ProjectChip onOpenCode={onOpenCode} />
      <span className="h-4 w-px shrink-0 bg-border/50" />

      {/* Center — panel tabs + tools + search (sits above the preview). */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5">
        {visible.map((panel) => {
          const Icon = panel.icon
          const active = activePanel === panel.id
          return (
            <div
              key={panel.id}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-2.5 text-[11px] text-muted-foreground transition-colors",
                active && "border-[#FF0000]/25 bg-[#FF0000]/[0.06] text-foreground",
                !active && "hover:bg-muted/55 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1"
                onClick={() => onTogglePanel(panel.id)}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", active && "text-[#FF0000]")} />
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
          aria-label="Invitar miembro al workspace"
          aria-pressed={inviteOpen}
          onClick={onOpenInvite}
          className={cn(
            "h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors",
            inviteOpen
              ? "bg-[#FF0000]/[0.07] text-[#C80000] shadow-[inset_0_0_0_1px_rgba(255,0,0,0.22)] dark:text-[#FF6B6B]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <UserPlus className="mr-1 h-3 w-3" />
          Invitar
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Código del proyecto"
          aria-pressed={codeOpen}
          onClick={onOpenCode}
          className={cn(
            "h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors",
            codeOpen
              ? "bg-[#FF0000]/[0.07] text-[#C80000] shadow-[inset_0_0_0_1px_rgba(255,0,0,0.22)] dark:text-[#FF6B6B]"
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
