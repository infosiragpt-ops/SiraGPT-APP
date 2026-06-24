"use client"

/**
 * ToolLauncher — minimal Replit-style tool dock for /code.
 *
 * A glass right-drawer catalog of workspace tools grouped into sections
 * (Pestañas abiertas · Sugerido · Avanzado · Archivos). Picking a tool
 * calls onSelect; the parent decides whether to open the single tool
 * screen or run an inline action.
 */

import * as React from "react"
import { ArrowUpRight, LayoutGrid, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
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
  onSelect: (id: WorkspaceToolId) => void
  /** Tools currently open (drives the dynamic "Pestañas abiertas" section). */
  openToolIds: WorkspaceToolId[]
}

type ToolLauncherItem =
  | { kind: "tool"; tool: WorkspaceTool }
  | { kind: "file"; path: string }
  | { kind: "new-file"; label: string; description: string }

type ToolLauncherSection = {
  id: string
  label: string
  items: ToolLauncherItem[]
}

const QUICK_TOOL_IDS: WorkspaceToolId[] = ["agent", "preview", "shell", "publishing"]

export function ToolLauncher({ open, onClose, onSelect, openToolIds }: Props) {
  const { files, openFile, createFile } = useCodeWorkspace()
  const [query, setQuery] = React.useState("")

  React.useEffect(() => {
    if (open) setQuery("")
  }, [open])

  // Esc closes the launcher.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const q = query.trim().toLowerCase()

  // Build the rendered sections: a dynamic open-tabs section first, then the
  // static catalog. Search collapses everything into a single flat result list.
  const sections = React.useMemo<ToolLauncherSection[]>(() => {
    if (q) {
      const toolMatches = Object.values(WORKSPACE_TOOLS).filter((tool) =>
        `${tool.label} ${tool.description} ${tool.keywords}`.toLowerCase().includes(q),
      )
      const fileMatches = Object.keys(files)
        .filter((path) => path.toLowerCase().includes(q))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 24)
      const wantsNewFile =
        ["new", "new file", "nuevo", "nuevo archivo", "crear", "create"].some((term) =>
          term.startsWith(q) || q.startsWith(term),
        )

      return [
        {
          id: "tool-results",
          label: "Herramientas",
          items: toolMatches.map((tool) => ({ kind: "tool" as const, tool })),
        },
        {
          id: "file-results",
          label: "Archivos",
          items: [
            ...(wantsNewFile
              ? [{ kind: "new-file" as const, label: "New file", description: "Crear un archivo nuevo" }]
              : []),
            ...fileMatches.map((path) => ({ kind: "file" as const, path })),
          ],
        },
      ]
    }
    const openTools = Array.from(new Set(openToolIds))
      .map((id) => WORKSPACE_TOOLS[id])
      .filter(Boolean)
    const dynamic: ToolLauncherSection[] = openTools.length
      ? [{
          id: "open",
          label: "Pestañas abiertas",
          items: openTools.map((tool) => ({ kind: "tool" as const, tool })),
        }]
      : []
    const stat = TOOL_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      items: s.toolIds
        .map((id) => WORKSPACE_TOOLS[id])
        .filter(Boolean)
        .map((tool) => ({ kind: "tool" as const, tool })),
    }))
    return [...dynamic, ...stat]
  }, [files, q, openToolIds])

  const handlePick = (item: ToolLauncherItem) => {
    if (item.kind === "tool") {
      onSelect(item.tool.id)
      return
    }
    if (item.kind === "file") {
      openFile(item.path)
      onClose()
      return
    }
    const path = window.prompt("Nombre del archivo (incluye ruta)")
    if (path) createFile(path, "")
    onClose()
  }

  // Render nothing when closed — an off-screen (translate-x-full) drawer would
  // overflow the parent panel and let autofocus scroll the surface sideways.
  if (!open) return null

  return (
    <>
      <div aria-hidden onClick={onClose} className="absolute inset-0 z-30" />

      <aside
        aria-label="Herramientas del workspace"
        className={cn(
          "absolute right-2 top-2 z-40 flex w-[390px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl",
          "border border-border/70 bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl",
          "max-h-[min(680px,calc(100dvh-5.5rem))]",
        )}
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground">
              <LayoutGrid className="h-3.5 w-3.5" />
            </span>
            <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
              Herramientas
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Cerrar herramientas"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>

        <div className="shrink-0 px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/35 px-2.5 py-1.5 focus-within:border-foreground/30 focus-within:ring-1 focus-within:ring-foreground/10">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar herramientas, archivos o acciones…"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Buscar herramienta"
            />
          </div>
        </div>

        {!q ? (
          <div className="grid shrink-0 grid-cols-4 gap-1.5 border-b border-border/45 px-3 pb-2">
            {QUICK_TOOL_IDS.map((id) => {
              const tool = WORKSPACE_TOOLS[id]
              const Icon = tool.icon
              return (
                <button
                  key={`quick:${id}`}
                  type="button"
                  onClick={() => handlePick({ kind: "tool", tool })}
                  className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg border border-border/50 bg-background/70 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon className="h-4 w-4" />
                  <span className="max-w-full truncate px-1">{tool.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sections.every((s) => s.items.length === 0) ? (
            <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              Sin resultados.
            </p>
          ) : (
            sections.map((section) =>
              section.items.length === 0 ? null : (
                <section key={section.id} className="mb-3">
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">
                    {section.label}
                  </p>
                  <ul className="space-y-0.5">
                    {section.items.map((item) => {
                      const isTool = item.kind === "tool"
                      const isFile = item.kind === "file"
                      const key = isTool
                        ? item.tool.id
                        : isFile
                          ? `file:${item.path}`
                          : "new-file-action"
                      const label = isTool ? item.tool.label : isFile ? item.path : item.label
                      const description = isTool
                        ? item.tool.description
                        : isFile
                          ? "Abrir archivo del workspace"
                          : item.description
                      const Icon = isTool ? item.tool.icon : WORKSPACE_TOOLS[isFile ? "files" : "new-file"].icon
                      return (
                        <li key={`${section.id}:${key}`}>
                          <button
                            type="button"
                            onClick={() => handlePick(item)}
                            className={cn(
                              "group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                              "hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none",
                            )}
                          >
                            <span
                              className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                                "border-border/50 bg-muted/40 text-muted-foreground",
                                "group-hover:border-foreground/20 group-hover:text-foreground",
                              )}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[12.5px] font-medium text-foreground">
                                  {label}
                                </span>
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {description}
                              </span>
                            </span>
                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ),
            )
          )}
        </div>
      </aside>
    </>
  )
}
