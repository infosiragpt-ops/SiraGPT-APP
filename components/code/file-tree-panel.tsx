"use client"

import * as React from "react"
import {
  Braces,
  ChevronRight,
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
  ScrollText,
  Search,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

// Cursor / VS-Code-style file-type icons + accent colors. Keeps the tree
// scannable: JSON in amber braces, shell in green, code in blue/yellow,
// logs dimmed, config/metadata as a gear, images in purple.
//
// NOTE: colors are applied INLINE (lucide icons stroke `currentColor`), not
// via Tailwind `text-amber-400` etc. — those saturated palette shades are not
// part of this project's compiled/curated Tailwind CSS, so they'd silently
// fall back to the inherited muted foreground. Inline hex is never purged.
type FileGlyph = { Icon: LucideIcon; color: string; dim?: boolean }

const MUTED = "hsl(var(--muted-foreground))"

function getFileGlyph(name: string): FileGlyph {
  const lower = name.toLowerCase()
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  switch (ext) {
    case "json":
    case "jsonl":
    case "json5":
      return { Icon: Braces, color: "#e3b341" }
    case "ts":
    case "tsx":
      return { Icon: FileCode2, color: "#4ab8e8" }
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { Icon: FileCode2, color: "#e8d44d" }
    case "py":
    case "rb":
    case "go":
    case "rs":
    case "java":
    case "kt":
    case "php":
    case "c":
    case "cpp":
    case "cs":
    case "swift":
      return { Icon: FileCode2, color: "#6cb6e8" }
    case "sh":
    case "bash":
    case "zsh":
      return { Icon: SquareTerminal, color: "#6cc24a" }
    case "css":
    case "scss":
    case "sass":
    case "less":
      return { Icon: FileCode2, color: "#e06c9f" }
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return { Icon: FileCode2, color: "#e0915c" }
    case "md":
    case "mdx":
    case "markdown":
      return { Icon: FileText, color: "#7aa7c7" }
    case "txt":
    case "text":
      return { Icon: FileText, color: `${MUTED.slice(0, -1)} / 0.6)` }
    case "log":
      return { Icon: ScrollText, color: `${MUTED.slice(0, -1)} / 0.45)`, dim: true }
    case "yml":
    case "yaml":
    case "toml":
    case "ini":
    case "env":
    case "conf":
    case "lock":
      return { Icon: FileCog, color: `${MUTED.slice(0, -1)} / 0.72)` }
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
      return { Icon: FileImage, color: "#b48ade" }
    default:
      if (lower.includes("metadata") || lower.includes(".config") || lower === "dockerfile") {
        return { Icon: FileCog, color: `${MUTED.slice(0, -1)} / 0.66)` }
      }
      return { Icon: File, color: `${MUTED.slice(0, -1)} / 0.55)` }
  }
}

// ── Tree model ──────────────────────────────────────────────────────────
export type TreeNode = {
  name: string // display segment (may be a compacted "a/b/c" chain)
  path: string // file path for files; directory path for folders
  isDir: boolean
  children: TreeNode[]
}

/**
 * Turn a flat list of paths into a folder tree. Single-child folder
 * chains are COMPACTED ("ui/upstream/openclaw") so a deep monorepo prefix
 * reads as one tidy row instead of six nested ones — the VS Code "compact
 * folders" behaviour. Folders sort before files, both alphabetical.
 */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] }
  for (const p of paths) {
    const segs = p.split("/").filter(Boolean)
    let node = root
    let acc = ""
    segs.forEach((seg, i) => {
      acc = acc ? `${acc}/${seg}` : seg
      const isFile = i === segs.length - 1
      let child = node.children.find((c) => c.name === seg && c.isDir === !isFile)
      if (!child) {
        child = { name: seg, path: isFile ? p : acc, isDir: !isFile, children: [] }
        node.children.push(child)
      }
      node = child
    })
  }

  const compact = (n: TreeNode): TreeNode => {
    let cur = n
    while (cur.isDir && cur.children.length === 1 && cur.children[0].isDir) {
      const only = cur.children[0]
      cur = { name: `${cur.name}/${only.name}`, path: only.path, isDir: true, children: only.children }
    }
    return { ...cur, children: cur.children.map(compact) }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
    n.children.forEach(sortRec)
  }

  const top = root.children.map(compact)
  top.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
  top.forEach(sortRec)
  return top
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] || path
}
function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(0, -1).join("/")
}

// ── Presentational tree (context-free, so it can be previewed) ───────────
type FileTreeProps = {
  nodes: TreeNode[]
  depth: number
  activePath: string | null
  collapsed: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onDelete: (path: string) => void
}

export function FileTree({ nodes, depth, activePath, collapsed, onToggle, onOpen, onDelete }: FileTreeProps) {
  return (
    <ul className="space-y-px">
      {nodes.map((node) => {
        const pad = 6 + depth * 11
        if (node.isDir) {
          const isOpen = !collapsed.has(node.path)
          return (
            <li key={`d:${node.path}`}>
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                style={{ paddingLeft: pad }}
                className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title={node.path}
              >
                <ChevronRight
                  className={cn("h-3 w-3 shrink-0 opacity-70 transition-transform", isOpen && "rotate-90")}
                />
                {isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "#6c9bd6" }} />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "#5f7da8" }} />
                )}
                <span className="truncate font-medium">{node.name}</span>
              </button>
              {isOpen && node.children.length > 0 && (
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  activePath={activePath}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              )}
            </li>
          )
        }
        const active = node.path === activePath
        const { Icon: FileIcon, color: iconColor, dim } = getFileGlyph(node.name)
        return (
          <li key={`f:${node.path}`} className="group flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(node.path)}
              style={{ paddingLeft: pad + 16 }}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pr-2 text-left text-[12.5px]",
                active
                  ? "bg-muted text-foreground"
                  : cn("hover:bg-muted/60 hover:text-foreground", dim ? "text-muted-foreground/55" : "text-muted-foreground"),
              )}
              title={node.path}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0" style={{ color: iconColor }} />
              <span className="truncate">{node.name}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={`Eliminar ${node.path}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(node.path)
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

// ── Panel (wires the workspace context) ─────────────────────────────────
export function FileTreePanel() {
  const { files, activePath, openFile, deleteFile, openLocalFolderWorkspace, workspaceSource } =
    useCodeWorkspace()

  const [query, setQuery] = React.useState("")
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  const allPaths = React.useMemo(() => Object.keys(files).sort((a, b) => a.localeCompare(b)), [files])
  const normalizedQuery = query.trim().toLowerCase()
  const tree = React.useMemo(() => buildFileTree(allPaths), [allPaths])

  const matches = React.useMemo(
    () => (normalizedQuery ? allPaths.filter((p) => p.toLowerCase().includes(normalizedQuery)) : []),
    [allPaths, normalizedQuery],
  )

  const toggle = React.useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleDelete = React.useCallback(
    (path: string) => {
      if (typeof window !== "undefined" && !window.confirm(`Eliminar ${path}?`)) return
      deleteFile(path)
    },
    [deleteFile],
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
      {/* Minimalist file search — filters by path substring. */}
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
        ) : normalizedQuery ? (
          // Search results: flat list, filename first + dimmed folder.
          matches.length === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">Sin resultados para «{query}»</p>
          ) : (
            <ul className="space-y-px">
              {matches.map((path) => {
                const active = path === activePath
                const dir = dirname(path)
                const { Icon: FileIcon, color: iconColor } = getFileGlyph(basename(path))
                return (
                  <li key={path} className="group flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => openFile(path)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px]",
                        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                      title={path}
                    >
                      <FileIcon className="h-3.5 w-3.5 shrink-0" style={{ color: iconColor }} />
                      <span className="truncate">{basename(path)}</span>
                      {dir && <span className="truncate text-[11px] text-muted-foreground/45">{dir}</span>}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={`Eliminar ${path}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(path)
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )
        ) : (
          <FileTree
            nodes={tree}
            depth={0}
            activePath={activePath}
            collapsed={collapsed}
            onToggle={toggle}
            onOpen={openFile}
            onDelete={handleDelete}
          />
        )}
      </div>
      <footer className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        {workspaceSource.linked ? "Sincronizado con carpeta local" : "Solo en este navegador"}
      </footer>
    </div>
  )
}
