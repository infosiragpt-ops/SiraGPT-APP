"use client"

/**
 * FileTree — recursive explorer for a server-side cloned workspace.
 * Click a file to open it; hover for rename/delete; toolbar adds files/folders.
 */

import * as React from "react"
import {
  ChevronRight,
  ChevronDown,
  File as FileIcon,
  Folder,
  FolderOpen,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  Trash2,
  Pencil,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { FileNode } from "@/lib/github-service"

interface Props {
  tree: FileNode[]
  activePath: string | null
  onOpen: (path: string) => void
  onNewFile: (parentDir: string) => void
  onNewFolder: (parentDir: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onRefresh: () => void
}

function Row({
  node,
  depth,
  activePath,
  onOpen,
  onRename,
  onDelete,
}: {
  node: FileNode
  depth: number
  activePath: string | null
  onOpen: (path: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
}) {
  const [open, setOpen] = React.useState(depth < 1)
  const isDir = node.type === "dir"
  const active = activePath === node.path

  return (
    <div>
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-sm hover:bg-foreground/5",
          active && "bg-foreground/10 text-foreground",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onOpen(node.path))}
      >
        {isDir ? (
          <>
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {open ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-sky-500" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-sky-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="flex-1 truncate">{node.name}</span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onRename(node.path)
            }}
            title="Renombrar"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:text-red-500"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(node.path)
            }}
            title="Eliminar"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      </div>
      {isDir && open && node.children && (
        <div>
          {node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({
  tree,
  activePath,
  onOpen,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onRefresh,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Archivos</span>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => onNewFile("")}
            title="Nuevo archivo"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => onNewFolder("")}
            title="Nueva carpeta"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={onRefresh}
            title="Refrescar"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tree.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">Workspace vacío.</p>
        ) : (
          tree.map((node) => (
            <Row
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
