"use client"

/**
 * ToolLauncher — futuristic, Replit-style tool dock for /code.
 *
 * A glass right-drawer catalog of workspace tools grouped into sections
 * (Pestañas abiertas · Sugerido · Avanzado · Archivos). Picking a tool
 * calls onSelect; the parent decides whether to open the single tool
 * screen or run an inline action.
 */

import * as React from "react"
import { ArrowUpRight, LayoutGrid, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
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

export function ToolLauncher({ open, onClose, onSelect, openToolIds }: Props) {
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
  const sections = React.useMemo(() => {
    if (q) {
      const matches = Object.values(WORKSPACE_TOOLS).filter(
        (t) =>
          t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      )
      return [{ id: "results", label: "Resultados", tools: matches }]
    }
    const open: WorkspaceTool[] = openToolIds
      .map((id) => WORKSPACE_TOOLS[id])
      .filter(Boolean)
    const dynamic = open.length
      ? [{ id: "open", label: "Pestañas abiertas", tools: open }]
      : []
    const stat = TOOL_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      tools: s.toolIds.map((id) => WORKSPACE_TOOLS[id]).filter(Boolean),
    }))
    return [...dynamic, ...stat]
  }, [q, openToolIds])

  const handlePick = (id: WorkspaceToolId) => {
    onSelect(id)
  }

  // Render nothing when closed — an off-screen (translate-x-full) drawer would
  // overflow the parent panel and let autofocus scroll the surface sideways.
  if (!open) return null

  return (
    <>
      {/* scrim — click outside to close, subtle dim so the editor stays legible */}
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 z-30 bg-background/30 backdrop-blur-[2px]"
      />

      <aside
        aria-label="Herramientas del workspace"
        className={cn(
          "absolute inset-y-0 right-0 z-40 flex w-[360px] max-w-[88vw] flex-col",
          // liquid-glass surface + violet edge glow
          "border-l border-white/10 bg-background/75 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/60",
          "shadow-[-28px_0_70px_-30px_rgba(124,92,255,0.55)]",
        )}
      >
        {/* futurist top hairline */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--accent-violet)/0.85)] to-transparent"
        />

        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))]">
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

        <div className="shrink-0 px-3 py-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5 shadow-inner backdrop-blur focus-within:border-[hsl(var(--accent-violet)/0.45)] focus-within:ring-1 focus-within:ring-[hsl(var(--accent-violet)/0.30)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar una herramienta…"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Buscar herramienta"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {sections.every((s) => s.tools.length === 0) ? (
            <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              Sin herramientas que coincidan.
            </p>
          ) : (
            sections.map((section) =>
              section.tools.length === 0 ? null : (
                <section key={section.id} className="mb-3">
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                    {section.label}
                  </p>
                  <ul className="space-y-0.5">
                    {section.tools.map((tool) => {
                      const Icon = tool.icon
                      const soon = tool.status === "soon"
                      return (
                        <li key={`${section.id}:${tool.id}`}>
                          <button
                            type="button"
                            onClick={() => handlePick(tool.id)}
                            className={cn(
                              "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                              "hover:bg-[hsl(var(--accent-violet)/0.10)] focus-visible:bg-[hsl(var(--accent-violet)/0.10)] focus-visible:outline-none",
                            )}
                          >
                            <span
                              className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
                                "border-border/50 bg-muted/40 text-muted-foreground",
                                "group-hover:border-[hsl(var(--accent-violet)/0.45)] group-hover:text-[hsl(var(--accent-violet))]",
                              )}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[12.5px] font-medium text-foreground">
                                  {tool.label}
                                </span>
                                {soon ? (
                                  <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Próximamente
                                  </span>
                                ) : null}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {tool.description}
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
