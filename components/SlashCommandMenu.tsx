"use client"

/**
 * SlashCommandMenu — a small popover that appears when the user types
 * "/" at the start of the chat input, listing the available "/<command>"
 * shortcuts. Selecting one inserts the command prefix into the input.
 *
 * Today's commands:
 *   /goal <descripción>   →  Runs the research-agent autonomous loop
 *                            (continues working through phases until the
 *                            goal is met — paper search + browser visits +
 *                            screenshot analysis + decision/refine cycle).
 *
 * The component is intentionally framework-light: it doesn't manage the
 * textarea focus or DOM itself, it just reports back via onCommandPick.
 */

import * as React from "react"
import { Target, Search, FileText } from "lucide-react"

export type SlashCommand = {
  id: string
  label: string
  /** Short description shown under the label. */
  description: string
  /** What gets inserted into the textarea (typically "/<id> "). */
  insert: string
  icon: React.ReactNode
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "goal",
    label: "Goal",
    description: "Encadena agente de investigación hasta cumplir el objetivo (papers, web, screenshots, decisiones).",
    insert: "/goal ",
    icon: <Target className="h-4 w-4" />,
  },
  {
    id: "research",
    label: "Research",
    description: "Búsqueda científica en arXiv + Semantic Scholar + OpenAlex + PubMed + Europe PMC.",
    insert: "/research ",
    icon: <Search className="h-4 w-4" />,
  },
  {
    id: "summarize",
    label: "Summarize",
    description: "Resume documentos adjuntos o el último mensaje.",
    insert: "/summarize ",
    icon: <FileText className="h-4 w-4" />,
  },
]

interface SlashCommandMenuProps {
  open: boolean
  /** Substring after the leading "/" (used to filter commands as the user types). */
  filter: string
  onCommandPick: (command: SlashCommand) => void
  onClose: () => void
}

export function SlashCommandMenu({ open, filter, onCommandPick, onClose }: SlashCommandMenuProps) {
  const [activeIdx, setActiveIdx] = React.useState(0)

  const visible = React.useMemo(() => {
    const q = filter.toLowerCase().trim()
    if (!q) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    )
  }, [filter])

  React.useEffect(() => {
    if (activeIdx >= visible.length) setActiveIdx(0)
  }, [visible.length, activeIdx])

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length))
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (visible[activeIdx]) {
          e.preventDefault()
          onCommandPick(visible[activeIdx])
        }
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, visible, activeIdx, onCommandPick, onClose])

  if (!open || visible.length === 0) return null

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full mb-2 left-2 right-2 max-w-md rounded-xl border border-border/60 bg-popover/95 shadow-xl backdrop-blur z-50 overflow-hidden"
    >
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border/40">
        Slash commands
      </div>
      <div className="max-h-64 overflow-y-auto">
        {visible.map((cmd, idx) => (
          <button
            key={cmd.id}
            type="button"
            role="option"
            aria-selected={idx === activeIdx}
            onClick={() => onCommandPick(cmd)}
            onMouseEnter={() => setActiveIdx(idx)}
            className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
              idx === activeIdx ? "bg-accent" : "hover:bg-accent/50"
            }`}
          >
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              {cmd.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="font-medium text-sm text-foreground">/{cmd.id}</span>
                <span className="text-xs text-muted-foreground">— {cmd.label}</span>
              </span>
              <span className="block text-xs text-muted-foreground leading-snug mt-0.5">
                {cmd.description}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border/40 bg-muted/30">
        ↑↓ navegar · Enter seleccionar · Esc cerrar
      </div>
    </div>
  )
}

/**
 * Helper used by the chat composer: detect when the user is currently typing a
 * leading slash command at the START of the input. Returns the filter substring
 * (after the "/") when applicable, or null when no command is being typed.
 *
 *   detectSlashFilter("")        → null
 *   detectSlashFilter("/")       → ""
 *   detectSlashFilter("/go")     → "go"
 *   detectSlashFilter("/goal x") → null  (whitespace ends the command)
 *   detectSlashFilter("hi /goal")→ null  (must be at the very start)
 */
export function detectSlashFilter(input: string): string | null {
  if (!input.startsWith("/")) return null
  const rest = input.slice(1)
  const m = rest.match(/^([a-zA-Z0-9_-]*)/)
  if (!m) return null
  // If anything after the leading word that isn't part of the command (a space
  // or another character), the user has moved past the slash-menu phase.
  if (rest.length > m[0].length) return null
  return m[0]
}

/**
 * Strips the leading "/<command> " prefix from a message and returns it,
 * along with the command id. Returns null when the message has no such
 * prefix or the command is unknown.
 *
 *   parseSlashPrefix("/goal investigate X") → { command: "goal", remainder: "investigate X" }
 *   parseSlashPrefix("/goal")               → { command: "goal", remainder: "" }
 *   parseSlashPrefix("hello")               → null
 */
export function parseSlashPrefix(input: string): { command: string; remainder: string } | null {
  const m = input.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const id = m[1].toLowerCase()
  const known = SLASH_COMMANDS.some((c) => c.id === id)
  if (!known) return null
  return { command: id, remainder: m[2] || "" }
}
