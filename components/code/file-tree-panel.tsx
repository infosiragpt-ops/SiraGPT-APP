"use client"

import * as React from "react"
import { FileCode2, FolderOpen, Search, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

export function FileTreePanel() {
  const { files, activePath, openFile, deleteFile, openLocalFolderWorkspace, workspaceSource } =
    useCodeWorkspace()

  const [query, setQuery] = React.useState("")

  const allPaths = React.useMemo(() => Object.keys(files).sort((a, b) => a.localeCompare(b)), [files])
  const normalizedQuery = query.trim().toLowerCase()
  const paths = React.useMemo(
    () => (normalizedQuery ? allPaths.filter((p) => p.toLowerCase().includes(normalizedQuery)) : allPaths),
    [allPaths, normalizedQuery],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        <span>Explorador</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px] normal-case"
          onClick={() => void openLocalFolderWorkspace()}
          title="Abrir carpeta local"
        >
          <FolderOpen className="h-3 w-3" />
          Carpeta
        </Button>
      </header>
      {/* Minimalist file search — filters the tree by path substring. */}
      <div className="shrink-0 border-b border-border/40 p-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar archivos…"
            aria-label="Buscar archivos"
            spellCheck={false}
            className={cn(
              "h-7 w-full rounded-md border border-border/60 bg-muted/30 pl-7 pr-7 text-[12px] text-foreground",
              "placeholder:text-muted-foreground/55 outline-none transition-colors",
              "focus-visible:border-[hsl(var(--accent-violet)/0.6)] focus-visible:bg-background",
            )}
          />
          {query && (
            <button
              type="button"
              aria-label="Limpiar búsqueda"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {allPaths.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">Sin archivos</p>
        ) : paths.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">Sin resultados para «{query}»</p>
        ) : (
          <ul className="space-y-0.5">
            {paths.map((path) => {
              const active = path === activePath
              return (
                <li key={path} className="group flex items-center gap-0.5">
                  <button
                    type="button"
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px]",
                      active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                    onClick={() => openFile(path)}
                  >
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="truncate font-mono">{path}</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Eliminar ${path}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (typeof window !== "undefined" && !window.confirm(`Eliminar ${path}?`)) return
                      deleteFile(path)
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <footer className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        {workspaceSource.linked ? "Sincronizado con carpeta local" : "Solo en este navegador"}
      </footer>
    </div>
  )
}
