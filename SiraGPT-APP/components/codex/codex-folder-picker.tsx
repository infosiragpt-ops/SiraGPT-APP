"use client"

/**
 * CodexFolderPicker — Cursor-style open-workspace menu (search · recents · open folder).
 */

import * as React from "react"
import { Folder, FolderOpen, FolderPlus, Home } from "lucide-react"

import { CodexMark } from "@/components/codex/codex-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  CODEX_UPDATED_EVENT,
  codexEntryDisplayPath,
  listCodexProjects,
  type CodexProjectEntry,
} from "@/lib/codex-projects"

export type CodexFolderPickerProps = {
  onOpenFolder: () => void
  onSelectEntry: (entry: CodexProjectEntry) => void
  onOpenHome?: () => void
  /** Icon in header/toolbar, or full-width row at panel bottom (Cursor). */
  triggerVariant?: "icon" | "folder-plus" | "open-workspace-row" | "codex-mark"
  triggerClassName?: string
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

export function CodexFolderPicker({
  onOpenFolder,
  onSelectEntry,
  onOpenHome,
  triggerVariant = "icon",
  triggerClassName,
  align = "start",
  side = "bottom",
}: CodexFolderPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [recents, setRecents] = React.useState<CodexProjectEntry[]>([])

  const refreshRecents = React.useCallback(() => {
    setRecents(listCodexProjects())
  }, [])

  React.useEffect(() => {
    if (!open) return
    refreshRecents()
    setQuery("")
  }, [open, refreshRecents])

  React.useEffect(() => {
    const handler = () => refreshRecents()
    window.addEventListener(CODEX_UPDATED_EVENT, handler)
    return () => window.removeEventListener(CODEX_UPDATED_EVENT, handler)
  }, [refreshRecents])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recents
    return recents.filter((row) => {
      const path = codexEntryDisplayPath(row).toLowerCase()
      return row.name.toLowerCase().includes(q) || path.includes(q)
    })
  }, [query, recents])

  const pick = (entry: CodexProjectEntry) => {
    setOpen(false)
    onSelectEntry(entry)
  }

  const openFolder = () => {
    setOpen(false)
    onOpenFolder()
  }

  const openHome = () => {
    setOpen(false)
    onOpenHome?.()
  }

  const trigger =
    triggerVariant === "open-workspace-row" ? (
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          triggerClassName,
        )}
      >
        <FolderPlus className="h-4 w-4 shrink-0" />
        <span>Abrir workspace</span>
      </button>
    ) : triggerVariant === "folder-plus" ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
          triggerClassName,
        )}
        aria-label="Abrir workspace"
      >
        <FolderPlus className="h-3.5 w-3.5" />
      </Button>
    ) : triggerVariant === "codex-mark" ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-8 w-8 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
          triggerClassName,
        )}
        aria-label="Codex"
        title="Codex"
      >
        <CodexMark />
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
          triggerClassName,
        )}
        aria-label="Abrir carpeta o workspace"
      >
        <Folder className="h-3.5 w-3.5" />
      </Button>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={6}
        className="w-[288px] rounded-xl border-border/70 p-0 shadow-lg"
      >
        <div className="border-b border-border/50 px-2.5 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Abrir carpeta o workspace…"
            className="h-8 border-0 bg-muted/30 px-2 text-[13px] shadow-none focus-visible:ring-1"
            autoFocus
          />
        </div>

        <div className="max-h-[240px] overflow-y-auto py-1">
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-medium text-muted-foreground/80">Recientes</p>
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground/75">Sin workspaces recientes.</p>
          ) : (
            <ul>
              {filtered.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-foreground/90 hover:bg-muted/50"
                    onClick={() => pick(entry)}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                      {codexEntryDisplayPath(entry)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {onOpenHome ? (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-muted/50"
              onClick={openHome}
            >
              <Home className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Inicio</span>
            </button>
          ) : null}
        </div>

        <div className="border-t border-border/50 py-1">
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-muted/50"
            onClick={openFolder}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>Abrir carpeta</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
