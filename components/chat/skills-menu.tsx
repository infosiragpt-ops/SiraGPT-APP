"use client"

/**
 * «+ → Skills» in the composer, claude.ai style: a submenu (desktop) or an
 * inline panel (mobile) listing the built-in document skills and the user's
 * Biblioteca skills. Picking one toggles it for the next message; the agent
 * receives its full instructions for that turn.
 */

import * as React from "react"
import { Check, ChevronDown, FileSpreadsheet, Search, Sparkles, WandSparkles } from "lucide-react"

import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { OfficeFileIcon } from "@/components/office-file-icon"
import type { ChatSkillSummary } from "@/lib/api"
import type { OfficeKind } from "@/lib/office-file-kind"
import { filterSkills, MAX_COMPOSER_SKILLS, type ComposerSkills } from "@/lib/chat/use-composer-skills"
import { cn } from "@/lib/utils"

const OFFICE_KIND: Record<string, OfficeKind> = { docx: "word", pptx: "powerpoint", xlsx: "excel", pdf: "pdf" }
const SEARCH_THRESHOLD = 6

export function SkillGlyph({ skill, className }: { skill: Pick<ChatSkillSummary, "name" | "source">; className?: string }) {
  const kind = skill.source === "builtin" ? OFFICE_KIND[skill.name] : undefined
  if (kind) return <OfficeFileIcon kind={kind} size={16} className={cn("h-4 w-4 shrink-0", className)} />
  if (skill.source === "builtin" && skill.name === "csv") {
    return <FileSpreadsheet aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} />
  }
  return <WandSparkles aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} />
}

function subtitleFor(skills: ComposerSkills): string {
  const count = skills.selected.length
  if (count > 0) return `${count} activa${count > 1 ? "s" : ""} para el próximo mensaje`
  return "Word, PowerPoint, Excel, PDF y las tuyas"
}

function SkillsList({ skills, onPicked }: { skills: ComposerSkills; onPicked?: () => void }) {
  const [query, setQuery] = React.useState("")
  const visible = filterSkills(skills.catalog, query)
  const builtins = visible.filter((s) => s.source === "builtin")
  const mine = visible.filter((s) => s.source !== "builtin")
  const atLimit = skills.selected.length >= MAX_COMPOSER_SKILLS

  const renderItem = (skill: ChatSkillSummary) => {
    const active = skills.isSelected(skill.name)
    return (
      <DropdownMenuItem
        key={skill.name}
        className="chat-skill-menu-item liquid-menu-item"
        data-testid={`chat-skill-option-${skill.name}`}
        aria-checked={active}
        role="menuitemcheckbox"
        onSelect={(event) => {
          event.preventDefault()
          skills.toggle(skill)
          onPicked?.()
        }}
      >
        <div className="flex w-full min-w-0 items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border/60 bg-background">
            <SkillGlyph skill={skill} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{skill.title || skill.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
          </span>
          <Check
            aria-hidden="true"
            className={cn("h-4 w-4 shrink-0 text-foreground transition-opacity", active ? "opacity-100" : "opacity-0")}
          />
        </div>
      </DropdownMenuItem>
    )
  }

  return (
    <div className="chat-skills-list" data-testid="chat-skills-list">
      {skills.catalog.length > SEARCH_THRESHOLD ? (
        <label className="mx-1 mb-1 flex h-8 items-center gap-2 rounded-md border border-border/60 bg-background px-2 text-xs text-muted-foreground focus-within:border-foreground/30">
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Buscar skills"
            aria-label="Buscar skills"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      ) : null}
      {builtins.length ? (
        <>
          <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">Integradas</div>
          {builtins.map(renderItem)}
        </>
      ) : null}
      {mine.length ? (
        <>
          <div className="mt-1 px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">Tu Biblioteca</div>
          {mine.map(renderItem)}
        </>
      ) : null}
      {!visible.length ? (
        <p className="px-2.5 py-3 text-xs text-muted-foreground">Ninguna skill coincide con «{query.trim()}».</p>
      ) : null}
      <p className="px-2.5 pb-1 pt-2 text-[11px] leading-snug text-muted-foreground">
        {skills.status === "loading"
          ? "Cargando tus skills…"
          : skills.status === "error"
            ? "No se pudieron cargar tus skills; las integradas siguen disponibles."
            : atLimit
              ? `Máximo ${MAX_COMPOSER_SKILLS} skills por mensaje.`
              : "La skill elegida guía la respuesta de tu próximo mensaje."}
      </p>
    </div>
  )
}

/** Desktop submenu + mobile inline panel, as two sibling rows of the «+» menu. */
export function SkillsMenu({ skills }: { skills: ComposerSkills }) {
  const [open, setOpen] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)

  const trigger = (
    <div className="flex w-full items-center gap-3">
      <div className="liquid-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Sparkles className="h-4 w-4 text-foreground/80" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="liquid-label text-sm font-medium">Skills</div>
        <div className="truncate text-xs text-muted-foreground">{subtitleFor(skills)}</div>
      </div>
    </div>
  )

  return (
    <>
      <DropdownMenuItem
        className="liquid-menu-item chat-skills-menu-trigger md:hidden"
        data-testid="chat-skills-mobile-trigger"
        onSelect={(event) => {
          event.preventDefault()
          skills.ensureLoaded()
          setMobileOpen((value) => !value)
        }}
      >
        {trigger}
        <ChevronDown className={cn("ml-2 h-4 w-4 shrink-0 opacity-60 transition-transform", mobileOpen && "rotate-180")} />
      </DropdownMenuItem>
      {mobileOpen ? (
        <div className="chat-mobile-skills-panel md:hidden">
          <SkillsList skills={skills} />
        </div>
      ) : null}
      <DropdownMenuSub
        open={open}
        onOpenChange={(next) => {
          if (next) skills.ensureLoaded()
          setOpen(next)
        }}
      >
        <DropdownMenuSubTrigger
          className="liquid-menu-item hidden md:flex"
          data-testid="chat-skills-trigger"
          onFocus={() => {
            skills.ensureLoaded()
            setOpen(true)
          }}
          onPointerEnter={() => {
            skills.ensureLoaded()
            setOpen(true)
          }}
        >
          {trigger}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            sideOffset={10}
            alignOffset={-4}
            collisionPadding={12}
            className="liquid-menu-surface w-72"
          >
            <SkillsList skills={skills} />
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    </>
  )
}

export default SkillsMenu
