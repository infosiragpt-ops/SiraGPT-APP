"use client"

/**
 * NewTabPane — Replit-style "Nueva pestaña" picker for /code.
 *
 * Clicking the + in the tab strip opens this full pane over the main area:
 * a search input, a quick-access grid (Agent · Preview · Shell · Publishing),
 * an "Ir a pestaña existente" section with the tabs already open, and the
 * tool catalog below (Sugerido · Avanzado · Archivos). Picking a tool calls
 * onSelectTool; picking an open tab calls onJumpToOpen. Fully keyboard
 * driven: type to search, ↑↓ to move, Enter to open, Esc to close.
 */

import * as React from "react"
import { ArrowUpRight, FilePlus2, FileText, Search } from "lucide-react"

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

// Large quick-access tiles shown while the search is empty (Replit's grid).
const QUICK_TOOL_IDS: WorkspaceToolId[] = ["agent", "preview", "shell", "publishing"]

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

  const quickTools = q
    ? []
    : QUICK_TOOL_IDS.map((id) => WORKSPACE_TOOLS[id]).filter((t): t is WorkspaceTool => Boolean(t))

  let flatIndex = -1

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-label="Nueva pestaña"
      onKeyDown={onKeyDown}
    >
      {/* Scoped entrance animation — inline keyframes keep it safe under the
          curated Tailwind build (no reliance on animate-* utilities). */}
      <style>{`
        @keyframes ntp-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .ntp-enter { animation: none !important; } }
      `}</style>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--accent-violet)/0.85)] to-transparent"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="ntp-enter mx-auto flex w-full max-w-[760px] flex-col px-6 pb-6 pt-8"
          style={{ animation: "ntp-enter 0.18s ease-out" }}
        >
          <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-background px-3.5 py-3 shadow-sm transition-shadow focus-within:border-foreground/25 focus-within:shadow-md focus-within:ring-2 focus-within:ring-foreground/5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar herramientas y archivos…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Buscar herramientas y archivos"
            />
            <kbd className="hidden shrink-0 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:block">
              Esc
            </kbd>
          </div>

          {quickTools.length > 0 ? (
            <div className="grid grid-cols-2 gap-2.5 pt-5 sm:grid-cols-4">
              {quickTools.map((tool) => {
                const Icon = tool.icon
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => pick({ kind: "tool", tool })}
                    className="group flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-4 text-center shadow-sm transition-all hover:-translate-y-px hover:border-foreground/20 hover:bg-muted/40 hover:shadow"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="text-[12.5px] font-semibold text-foreground">{tool.label}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {flatItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-1 py-14 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-muted-foreground">
                <Search className="h-4 w-4" />
              </span>
              <p className="text-[13px] font-medium text-foreground">Sin resultados</p>
              <p className="text-[12px] text-muted-foreground">
                Prueba con otro nombre de herramienta o archivo.
              </p>
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.id} className="pt-6">
                <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {section.label}
                </p>
                <ul className="overflow-hidden rounded-xl border border-border/50 bg-card/40">
                  {section.items.map((item, itemIdx) => {
                    flatIndex += 1
                    const index = flatIndex
                    const highlighted = index === cursor
                    return (
                      <PaneRow
                        key={`${section.id}:${itemKey(item)}`}
                        item={item}
                        highlighted={highlighted}
                        first={itemIdx === 0}
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

      <footer className="flex shrink-0 items-center justify-center gap-4 border-t border-border/50 bg-background/95 px-6 py-2.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0.5 text-[10px] font-medium">↑</kbd>
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0.5 text-[10px] font-medium">↓</kbd>
          navegar
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium">↵</kbd>
          abrir
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium">Esc</kbd>
          cerrar
        </span>
      </footer>
    </div>
  )
}

function PaneRow({
  item,
  highlighted,
  first,
  onHover,
  onSelect,
}: {
  item: PaneItem
  highlighted: boolean
  first: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const ref = React.useRef<HTMLLIElement>(null)

  // Keep the keyboard cursor visible while navigating long sections.
  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" })
  }, [highlighted])

  const isToolish = item.kind === "tool" || item.kind === "open-tab"
  const Icon = isToolish ? item.tool.icon : item.kind === "file" ? FileText : FilePlus2
  const title = isToolish ? item.tool.label : item.kind === "file" ? item.path : "Nuevo archivo"
  const description = isToolish
    ? item.tool.description
    : item.kind === "file"
      ? "Abrir archivo del workspace"
      : "Crear un archivo nuevo"

  return (
    <li ref={ref} className={cn(!first && "border-t border-border/40")}>
      <button
        type="button"
        onClick={onSelect}
        onMouseMove={onHover}
        className={cn(
          "relative flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors",
          highlighted ? "bg-muted/70" : "hover:bg-muted/40",
        )}
      >
        {/* Left accent for the keyboard cursor — reads as "selected", not hovered. */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-1.5 left-0 w-[3px] rounded-r-full transition-opacity",
            highlighted ? "opacity-100" : "opacity-0",
          )}
          style={{ backgroundColor: "hsl(var(--accent-violet, 262 83% 66%))" }}
        />
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors",
            highlighted
              ? "border-foreground/15 bg-background text-foreground shadow-sm"
              : "border-border/60 bg-muted/40 text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-foreground">{title}</span>
            {item.kind === "open-tab" ? (
              <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-px text-[10px] font-medium text-muted-foreground">
                Abierta
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            {description}
          </span>
        </span>
        <ArrowUpRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-opacity",
            highlighted ? "opacity-100" : "opacity-0",
          )}
        />
      </button>
    </li>
  )
}
