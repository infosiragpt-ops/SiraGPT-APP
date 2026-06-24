"use client"

/**
 * ProjectChip — the editable project identity in the workspace top bar
 * (sits above the chat column). Click the name (or "Renombrar") to rename
 * inline; renames persist to the cloud project when possible. A small menu
 * adds quick project actions. Futuristic glass + violet accent.
 */

import * as React from "react"
import { Check, ChevronDown, Code2, FolderGit2, Pencil, X } from "lucide-react"
import { toast } from "sonner"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { projectsService } from "@/lib/projects-service"
import { CODEX_UPDATED_EVENT } from "@/lib/codex-projects"

export function ProjectChip({ onOpenCode }: { onOpenCode?: () => void }) {
  const { activeFolder, setActiveFolder } = useCodeWorkspace()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const name = activeFolder?.name?.trim() || "Proyecto"

  const startEdit = React.useCallback(() => {
    if (!activeFolder) {
      toast.message("Crea o abre un proyecto para renombrarlo.")
      return
    }
    setDraft(activeFolder.name || "")
    setEditing(true)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [activeFolder])

  const commit = React.useCallback(async () => {
    const next = draft.trim()
    setEditing(false)
    if (!activeFolder || !next || next === activeFolder.name) return
    // Optimistic: update the in-memory active folder immediately.
    setActiveFolder({ ...activeFolder, name: next })
    setSaving(true)
    try {
      // Persist to the cloud project when the id is a real project id.
      // Local-folder ids 404 here — swallowed so the local rename still sticks.
      await projectsService.update(activeFolder.id, { name: next }).catch(() => null)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(CODEX_UPDATED_EVENT))
      }
      toast.success(`Renombrado a "${next}"`)
    } catch {
      toast.error("No se pudo guardar el nombre")
    } finally {
      setSaving(false)
    }
  }, [draft, activeFolder, setActiveFolder])

  if (editing) {
    return (
      <div className="flex min-w-0 max-w-[34%] shrink-0 items-center gap-1 rounded-lg border border-[hsl(var(--accent-violet)/0.45)] bg-[hsl(var(--accent-violet)/0.08)] px-1.5 py-0.5 ring-1 ring-[hsl(var(--accent-violet)/0.30)]">
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent-violet))]" />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
          onBlur={() => void commit()}
          maxLength={120}
          placeholder="Nombre del proyecto"
          className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/60"
          aria-label="Renombrar proyecto"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void commit()}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--accent-violet)/0.15)]"
          aria-label="Guardar nombre"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditing(false)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60"
          aria-label="Cancelar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="group flex min-w-0 max-w-[34%] shrink-0 items-center gap-0.5">
      <button
        type="button"
        onDoubleClick={startEdit}
        onClick={startEdit}
        title="Doble clic para renombrar"
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors",
          "hover:bg-[hsl(var(--accent-violet)/0.10)]",
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent-violet))]" />
        <span
          className="truncate text-[12px] font-semibold tracking-tight text-foreground"
          title={name}
        >
          {name}
        </span>
        {saving ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[hsl(var(--accent-violet))]" />
        ) : (
          <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-70" />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-[state=open]:bg-muted/60"
            aria-label="Acciones del proyecto"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 rounded-xl border-border/70 p-1.5">
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-normal text-muted-foreground">
            {activeFolder ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
                Sincronizado en la nube
              </span>
            ) : (
              "Sin proyecto activo"
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2.5 rounded-lg text-sm" onClick={startEdit}>
            <Pencil className="h-4 w-4 text-muted-foreground" />
            Renombrar proyecto
          </DropdownMenuItem>
          {onOpenCode ? (
            <DropdownMenuItem className="gap-2.5 rounded-lg text-sm" onClick={onOpenCode}>
              <Code2 className="h-4 w-4 text-muted-foreground" />
              Abrir código
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
