"use client"

/**
 * FileTreePanel — left column of the /code workspace. Renders the
 * virtual file system from the workspace context as a flat list (the
 * MVP keeps things simple — folders are inferred visually by path
 * prefix but not as a real tree). Supports:
 *
 *   - Click to open a file in a tab.
 *   - + button to create a new file (prompts for a path).
 *   - Per-row context menu for rename / delete.
 *   - Reset workspace at the bottom for "back to defaults".
 *
 * We deliberately avoid showing system-style icons per filetype to
 * keep the visual quiet; the language is reflected by the editor
 * itself. The active row mirrors the editor's active tab.
 */

import * as React from "react"
import { FilePlus2, Pencil, RotateCcw, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export function FileTreePanel() {
  const {
    files,
    activePath,
    setActiveTab,
    createFile,
    renameFile,
    deleteFile,
    resetWorkspace,
  } = useCodeWorkspace()

  const sortedPaths = React.useMemo(
    () => Object.keys(files).sort((a, b) => a.localeCompare(b)),
    [files],
  )

  const handleCreate = () => {
    if (typeof window === "undefined") return
    const path = window.prompt("Nombre del archivo (incluye la ruta, p. ej. src/app.tsx)")
    if (!path) return
    createFile(path, "")
  }

  const handleRename = (oldPath: string) => {
    if (typeof window === "undefined") return
    const next = window.prompt("Nueva ruta del archivo", oldPath)
    if (!next || next === oldPath) return
    renameFile(oldPath, next)
  }

  const handleDelete = (path: string) => {
    if (typeof window === "undefined") return
    if (!window.confirm(`¿Eliminar ${path}?`)) return
    deleteFile(path)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span>Archivos</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCreate}
          title="Nuevo archivo"
          aria-label="Nuevo archivo"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sortedPaths.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <ThinkingIndicator size="sm" className="mx-auto mb-2 opacity-60" />
            Cargando workspace…
          </div>
        ) : (
          sortedPaths.map((path) => (
            <FileRow
              key={path}
              path={path}
              active={path === activePath}
              onSelect={() => setActiveTab(path)}
              onRename={() => handleRename(path)}
              onDelete={() => handleDelete(path)}
            />
          ))
        )}
      </div>
      <div className="shrink-0 border-t border-border/60 p-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start gap-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (typeof window === "undefined") return
            if (!window.confirm("Esto restaurará los archivos de ejemplo y descartará el workspace actual.")) return
            resetWorkspace()
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restaurar ejemplo
        </Button>
      </div>
    </div>
  )
}

function FileRow({
  path,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  path: string
  active: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-1 text-sm",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onSelect}
        className="min-w-0 flex-1 truncate text-left"
        title={path}
      >
        <span className="text-muted-foreground/80">
          {path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""}
        </span>
        <span className={cn(active ? "font-medium text-foreground" : "")}>
          {path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 transition-opacity md:group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onRename()
          }}
          title="Renombrar"
          aria-label="Renombrar"
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-rose-500"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Eliminar"
          aria-label="Eliminar"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
