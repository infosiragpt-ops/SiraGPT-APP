"use client"

import * as React from "react"
import { FileCode2, FolderOpen, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

export function FileTreePanel() {
  const { files, activePath, openFile, deleteFile, openLocalFolderWorkspace, workspaceSource } =
    useCodeWorkspace()

  const paths = React.useMemo(() => Object.keys(files).sort((a, b) => a.localeCompare(b)), [files])

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
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {paths.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">Sin archivos</p>
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
