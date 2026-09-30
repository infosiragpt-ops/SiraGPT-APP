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
import { Target, Search, FileText, ScrollText } from "lucide-react"

import type { ChatSkillSummary } from "@/lib/api"

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
  /** The user's enabled Agent Skills: «/» lists them first, claude.ai style. */
  skills?: ChatSkillSummary[]
  onSkillPick?: (skill: ChatSkillSummary) => void
}

type SlashItem =
  | { kind: "skill"; id: string; skill: ChatSkillSummary }
  | { kind: "command"; id: string; command: SlashCommand }

const MAX_SLASH_SKILLS = 30

export function SlashCommandMenu({ open, filter, onCommandPick, onClose, skills = [], onSkillPick }: SlashCommandMenuProps) {
  const [activeIdx, setActiveIdx] = React.useState(0)

  const visible = React.useMemo<SlashItem[]>(() => {
    const q = filter.toLowerCase().trim()
    const skillItems: SlashItem[] = onSkillPick
      ? [...skills]
          .filter((s) => !q || s.name.startsWith(q) || s.name.includes(q) || (s.title || "").toLowerCase().includes(q))
          .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name, "es"))
          .slice(0, MAX_SLASH_SKILLS)
          .map((skill) => ({ kind: "skill" as const, id: `skill-${skill.name}`, skill }))
      : []
    const commands = !q
      ? SLASH_COMMANDS
      : SLASH_COMMANDS.filter(
          (c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
        )
    return skillItems.concat(commands.map((command) => ({ kind: "command" as const, id: `cmd-${command.id}`, command })))
  }, [filter, skills, onSkillPick])

  const pick = React.useCallback((item: SlashItem) => {
    if (item.kind === "skill") onSkillPick?.(item.skill)
    else onCommandPick(item.command)
  }, [onCommandPick, onSkillPick])

  React.useEffect(() => {
    if (activeIdx >= visible.length) setActiveIdx(0)
  }, [visible.length, activeIdx])

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      // IME composition (CJK, dead keys): Enter/arrows belong to the IME.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === "Escape") {
        // Mark the key as consumed so the composer's own Esc handler
        // (close tools / blur) does not also run.
        e.preventDefault()
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
          pick(visible[activeIdx])
        }
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, visible, activeIdx, pick, onClose])

  if (!open || visible.length === 0) return null

  const active = visible[activeIdx]
  const itemName = (item: SlashItem) => (item.kind === "skill" ? item.skill.name : item.command.id)
  const itemLabel = (item: SlashItem) => (item.kind === "skill" ? "skill" : item.command.label)
  const optionId = (item: SlashItem) => (item.kind === "skill" ? `slash-skill-${item.skill.name}` : `slash-cmd-${item.command.id}`)

  return (
    <>
    {/* Focus stays in the composer textarea, so aria-activedescendant on the
        listbox is never announced; a polite live region reads the highlighted
        command as ↑/↓ move through the list. It sits outside the listbox,
        whose children may only be options. */}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {active
        ? `/${itemName(active)}, ${itemLabel(active)}, ${activeIdx + 1} de ${visible.length}`
        : ""}
    </span>
    <div
      role="listbox"
      aria-label="Comandos"
      aria-activedescendant={active ? optionId(active) : undefined}
      tabIndex={-1}
      data-testid="slash-command-menu"
      className="absolute bottom-full mb-2 left-2 right-2 max-w-md rounded-xl border border-border/60 bg-popover/95 shadow-xl backdrop-blur z-50 overflow-hidden"
    >
      <div className="max-h-72 overflow-y-auto py-1">
        {visible.map((item, idx) => {
          const prev = visible[idx - 1]
          const header = !prev || prev.kind !== item.kind
            ? (item.kind === "skill" ? "Skills" : "Comandos")
            : null
          const highlighted = idx === activeIdx
          return (
            <React.Fragment key={item.id}>
              {header ? (
                <div role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {header}
                </div>
              ) : null}
              {item.kind === "skill" ? (
                <button
                  id={optionId(item)}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  data-testid={`slash-skill-${item.skill.name}`}
                  onClick={() => pick(item)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`w-full flex items-center gap-3 px-3 py-1.5 text-left transition-colors ${
                    highlighted ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <ScrollText aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground/80" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.skill.name}</span>
                  <span className="hidden max-w-[55%] truncate text-xs text-muted-foreground sm:block">{item.skill.description}</span>
                </button>
              ) : (
                <button
                  id={optionId(item)}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  onClick={() => pick(item)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
                    highlighted ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    {item.command.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium text-sm text-foreground">/{item.command.id}</span>
                      <span className="text-xs text-muted-foreground">— {item.command.label}</span>
                    </span>
                    <span className="block text-xs text-muted-foreground leading-snug mt-0.5">
                      {item.command.description}
                    </span>
                  </span>
                </button>
              )}
            </React.Fragment>
          )
        })}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border/40 bg-muted/30">
        ↑↓ navegar · Enter seleccionar · Esc cerrar
      </div>
    </div>
    </>
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
