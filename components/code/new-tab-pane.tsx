"use client"

/**
 * NewTabPane — Replit-style "Nueva pestaña" picker for /code.
 *
 * Clicking the + in the tab strip opens this full pane over the main area
 * (the same tile Replit uses): a big "Buscar herramientas y archivos…"
 * input, an "Ir a pestaña existente" section with the tabs already open,
 * and the tool catalog below (Sugerido · Avanzado · Archivos). Picking a
 * tool calls onSelectTool; picking an open tab calls onJumpToOpen.
 */

import * as React from "react"
import { FilePlus2, FileText, Search } from "lucide-react"

import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { cn } from "@/lib/utils"
import {
  TOOL_SECTIONS,
  WORKSPACE_TOOLS,
  type WorkspaceTool,
  type WorkspaceToolId,
} from "@/lib/code-workspace-tools"

type Props = {
  open: boolean
  onClose: () => void
  onSelectTool: (id: WorkspaceToolId) => void
  /** Focus a tab that is already open (drives "Ir a pestaña existente"). */
  onJumpToOpen: (id: WorkspaceToolId) => void
  openToolIds: WorkspaceToolId[]
}

type PaneItem =
  | { kind: "open-tab"; tool: WorkspaceTool }
  | { kind: "tool"; tool: WorkspaceTool }
  | { kind: "file"; path: string }
  | { kind: "new-file" }

type PaneSection = {
  id: string
  label: string
  items: PaneItem[]
}

function itemKey(item: PaneItem): string {
  switch (item.kind) {
    case "open-tab":
      return `open:${item.tool.id}`
    case "tool":
      return `tool:${item.tool.id}`
    case "file":
      return `file:${item.path}`
    case "new-file":
      return "new-file"
  }
}

export function NewTabPane({ open, onClose, onSelectTool, onJumpToOpen, openToolIds }: Props) {
  const { files, openFile, createFile } = useCodeWorkspace()
  const [query, setQuery] = React.useState("")
  const [cursor, setCursor] = React.useState(0)

  React.useEffect(() => {
    if (open) {
      setQuery("")
      setCursor(0)
    }
  }, [open])

  const q = query.trim().toLowerCase()

  const sections = React.useMemo<PaneSection[]>(() => {
    if (q) {
      const toolMatches = Object.values(WORKSPACE_TOOLS).filter((tool) =>
        `${tool.label} ${tool.description} ${tool.keywords}`.toLowerCase().includes(q),
      )
      const openSet = new Set(openToolIds)
      const fileMatches = Object.keys(files)
        .filter((path) => path.toLowerCase().includes(q))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 24)
      const wantsNewFile = ["new", "new file", "nuevo", "nuevo archivo", "crear", "create"].some(
        (term) => term.startsWith(q) || q.startsWith(term),
      )
      return [
        {
          id: "tools",
          label: "Herramientas",
          items: toolMatches.map((tool) =>
            openSet.has(tool.id)
              ? { kind: "open-tab" as const, tool }
              : { kind: "tool" as const, tool },
          ),
        },
        {
          id: "files",
          label: "Archivos",
          items: [
            ...(wantsNewFile ? [{ kind: "new-file" as const }] : []),
            ...fileMatches.map((path) => ({ kind: "file" as const, path })),
          ],
        },
      ].filter((section) => section.items.length > 0)
    }

    const openTools = Array.from(new Set(openToolIds))
      .map((id) => WORKSPACE_TOOLS[id])
      .filter(Boolean)
    const openSet = new Set(openTools.map((tool) => tool.id))
    const result: PaneSection[] = []
    if (openTools.length > 0) {
      result.push({
        id: "open",
        label: "Ir a pestaña existente",
        items: openTools.map((tool) => ({ kind: "open-tab" as const, tool })),
      })
    }
    for (const section of TOOL_SECTIONS) {
      const items = section.toolIds
        .map((id) => WORKSPACE_TOOLS[id])
        .filter((tool): tool is WorkspaceTool => Boolean(tool))
        // Replit's "Suggested" hides what's already open (it lives above,
        // under "Jump to existing tab") — mirror that.
        .filter((tool) => section.id !== "suggested" || !openSet.has(tool.id))
        .map((tool) => ({ kind: "tool" as const, tool }))
      if (items.length > 0) {
        result.push({
          id: section.id,
          label: section.id === "suggested" ? "Sugerido" : section.label,
          items,
        })
      }
    }
    return result
  }, [files, openToolIds, q])

  const flatItems = React.useMemo(() => sections.flatMap((section) => section.items), [sections])

  React.useEffect(() => {
    setCursor(0)
  }, [q])

  const pick = React.useCallback(
    (item: PaneItem) => {
      switch (item.kind) {
        case "open-tab":
          onJumpToOpen(item.tool.id)
          return
        case "tool":
          onSelectTool(item.tool.id)
          return
        case "file":
          openFile(item.path)
          onClose()
          return
        case "new-file": {
          const path = window.prompt("Nombre del archivo (incluye ruta)")
          if (path) createFile(path, "")
          onClose()
        }
      }
    },
    [createFile, onClose, onJumpToOpen, onSelectTool, openFile],
  )

  // Esc closes; arrows + Enter drive the highlighted row (list-level so it
  // works while the search input keeps focus).
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setCursor((value) => Math.min(value + 1, Math.max(flatItems.length - 1, 0)))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setCursor((value) => Math.max(value - 1, 0))
        return
      }
      if (e.key === "Enter") {
        const item = flatItems[cursor]
        if (item) {
          e.preventDefault()
          pick(item)
        }
      }
    },
    [cursor, flatItems, onClose, pick],
  )

  if (!open) return null

  let flatIndex = -1

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-label="Nueva pestaña"
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--accent-violet)/0.85)] to-transparent"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col px-6 pb-10 pt-8">
          <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-3 py-2.5 shadow-sm focus-within:border-foreground/30 focus-within:ring-1 focus-within:ring-foreground/10">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar herramientas y archivos…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Buscar herramientas y archivos"
            />
          </div>

          {flatItems.length === 0 ? (
            <p className="px-1 py-10 text-center text-[13px] text-muted-foreground">
              Sin resultados.
            </p>
          ) : (
            sections.map((section) => (
              <section key={section.id} className="pt-6">
                <p className="px-1 pb-1.5 text-[13px] font-medium text-muted-foreground">
                  {section.label}
                </p>
                <ul>
                  {section.items.map((item) => {
                    flatIndex += 1
                    const index = flatIndex
                    const highlighted = index === cursor
                    return (
                      <PaneRow
                        key={`${section.id}:${itemKey(item)}`}
                        item={item}
                        highlighted={highlighted}
                        onHover={() => setCursor(index)}
                        onSelect={() => pick(item)}
                      />
                    )
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function PaneRow({
  item,
  highlighted,
  onHover,
  onSelect,
}: {
  item: PaneItem
  highlighted: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const isToolish = item.kind === "tool" || item.kind === "open-tab"
  const Icon = isToolish ? item.tool.icon : item.kind === "file" ? FileText : FilePlus2
  const title = isToolish ? item.tool.label : item.kind === "file" ? item.path : "New file"
  const description = isToolish
    ? item.tool.description
    : item.kind === "file"
      ? "Abrir archivo del workspace"
      : "Crear un archivo nuevo"

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        onMouseMove={onHover}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
          highlighted ? "bg-muted/70" : "hover:bg-muted/50",
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}
