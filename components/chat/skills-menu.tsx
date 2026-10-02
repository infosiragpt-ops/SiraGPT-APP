"use client"

/**
 * «+ → Skills» in the composer, claude.ai style: a flat list of the user's
 * enabled skills (scroll icon + name), then «Gestionar habilidades» (opens
 * Ajustes → Skills · Tuyos) and «Explorar habilidades» (Descubrir). A
 * submenu on desktop, an inline panel on mobile. Picking a skill toggles it
 * for the next message; the agent receives its full instructions.
 */

import * as React from "react"
import { Briefcase, Check, ChevronDown, Plus, ScrollText, Search } from "lucide-react"

import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import type { ChatSkillSummary } from "@/lib/api"
import { openSettingsSection } from "@/lib/chat/open-settings"
import { filterSkills, MAX_COMPOSER_SKILLS, type ComposerSkills } from "@/lib/chat/use-composer-skills"
import { cn } from "@/lib/utils"

const SEARCH_THRESHOLD = 8

export function SkillGlyph({ className }: { skill?: Pick<ChatSkillSummary, "name" | "source">; className?: string }) {
  return <ScrollText aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-foreground/80", className)} />
}

function subtitleFor(skills: ComposerSkills): string {
  const count = skills.selected.length
  if (count > 0) return `${count} activa${count > 1 ? "s" : ""} para el próximo mensaje`
  return "Word, PowerPoint, Excel, PDF y las tuyas"
}

/** Alphabetical, like claude.ai's picker. */
function sortSkills(list: ChatSkillSummary[]) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "es"))
}

function SkillsList({ skills, onPicked }: { skills: ComposerSkills; onPicked?: () => void }) {
  const [query, setQuery] = React.useState("")
  const visible = sortSkills(filterSkills(skills.catalog, query))
  const atLimit = skills.selected.length >= MAX_COMPOSER_SKILLS

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
      <div className="chat-skills-scroll max-h-[min(19rem,50vh)] overflow-y-auto overscroll-contain">
        {visible.map((skill) => {
          const active = skills.isSelected(skill.name)
          return (
            <DropdownMenuItem
              key={skill.name}
              className="chat-skill-menu-item liquid-menu-item"
              data-testid={`chat-skill-option-${skill.name}`}
              aria-checked={active}
              role="menuitemcheckbox"
              title={skill.description}
              onSelect={(event) => {
                event.preventDefault()
                skills.toggle(skill)
                onPicked?.()
              }}
            >
              <div className="flex w-full min-w-0 items-center gap-3">
                <SkillGlyph skill={skill} />
                <span className="min-w-0 flex-1 truncate text-sm">{skill.name}</span>
                <Check
                  aria-hidden="true"
                  className={cn("h-4 w-4 shrink-0 text-foreground transition-opacity", active ? "opacity-100" : "opacity-0")}
                />
              </div>
            </DropdownMenuItem>
          )
        })}
        {!visible.length ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {query.trim() ? `Ninguna skill coincide con «${query.trim()}».` : "No tienes skills activas."}
          </p>
        ) : null}
      </div>
      {skills.status === "error" || atLimit ? (
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {skills.status === "error"
            ? "No se pudieron cargar tus skills; las integradas siguen disponibles."
            : `Máximo ${MAX_COMPOSER_SKILLS} skills por mensaje.`}
        </p>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="chat-skill-menu-item liquid-menu-item"
        data-testid="chat-skills-manage"
        onSelect={() => openSettingsSection("skills", { skillsTab: "mine" })}
      >
        <div className="flex w-full items-center gap-3">
          <Briefcase aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground/80" />
          <span className="text-sm">Gestionar habilidades</span>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem
        className="chat-skill-menu-item liquid-menu-item"
        data-testid="chat-skills-explore"
        onSelect={() => openSettingsSection("skills", { skillsTab: "discover" })}
      >
        <div className="flex w-full items-center gap-3">
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground/80" />
          <span className="text-sm">Explorar habilidades</span>
        </div>
      </DropdownMenuItem>
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
        <ScrollText className="h-4 w-4 text-foreground/80" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="liquid-label text-sm font-medium">Habilidades (skills)</div>
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
            className="liquid-menu-surface w-64"
          >
            <SkillsList skills={skills} />
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    </>
  )
}

export default SkillsMenu
