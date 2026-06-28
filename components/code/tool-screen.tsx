"use client"

/**
 * ToolScreen — the single active workspace tool surface ("una pantalla a la
 * vez"). Overlays the editor/preview region; shows exactly one tool chosen
 * from the ToolLauncher. Ready tools render their real component and actions.
 */

import * as React from "react"
import { ArrowLeft, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { WORKSPACE_TOOLS, type WorkspaceToolId } from "@/lib/code-workspace-tools"

import { FileTreePanel } from "./file-tree-panel"
import { PreviewPane } from "./preview-pane"
import { SearchPanel } from "./search-panel"
import { TerminalPanel } from "./terminal-panel"
import { WorkspaceToolPanel } from "./workspace-tool-panels"

type Props = {
  toolId: WorkspaceToolId | null
  onClose: () => void
  onBackToLauncher: () => void
}

export function ToolScreen({ toolId, onClose, onBackToLauncher }: Props) {
  // Esc closes the screen.
  React.useEffect(() => {
    if (!toolId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toolId, onClose])

  const tool = toolId ? WORKSPACE_TOOLS[toolId] : null
  if (!tool) return null

  const Icon = tool.icon

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      role="dialog"
      aria-label={tool.label}
    >
      {/* violet edge glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--accent-violet)/0.85)] to-transparent"
      />

      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Volver a herramientas"
            onClick={onBackToLauncher}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))]">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
            {tool.label}
          </span>
          <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
            · {tool.description}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
          aria-label="Cerrar"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ToolBody toolId={tool.id} onClose={onClose} />
      </div>
    </div>
  )
}

function ToolBody({
  toolId,
  onClose,
}: {
  toolId: WorkspaceToolId
  onClose: () => void
}) {
  switch (toolId) {
    case "preview":
      return <PreviewPane onClose={onClose} />
    case "shell":
      return <TerminalPanel open onClose={onClose} />
    case "files":
      return <FileTreePanel />
    case "code-search":
      return <SearchPanel />
    default:
      return <WorkspaceToolPanel toolId={toolId} />
  }
}
