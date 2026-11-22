"use client"

/**
 * «+ → Skills» in the composer, claude.ai style: a flat list of the user's
 * enabled skills (scroll icon + name), then «Gestionar habilidades» (opens
 * Ajustes → Skills · Tuyos) and «Explorar habilidades» (Descubrir). A
 * submenu on desktop, an inline panel on mobile. Picking a skill toggles it
 * for the next message; the agent receives its full instructions.
 */

import * as React from "react"
import {
  BarChart3,
  BookOpen,
  Briefcase,
  Check,
  ChevronDown,
  Code2,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Plus,
  Presentation,
  ScrollText,
  Search,
  Sparkles,
  Table2,
  WandSparkles,
} from "lucide-react"

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

const CORE_SKILL_ORDER: Record<string, number> = {
  docx: 1,
  xlsx: 2,
  pptx: 3,
  pdf: 4,
  csv: 5,
  "skill-creator": 6,
}

export function SkillGlyph({
  skill,
  className,
}: {
  skill?: Pick<ChatSkillSummary, "name" | "source"> & { category?: string }
  className?: string
}) {
  const name = String(skill?.name || "").toLowerCase()
  if (name === "docx") return <FileText aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400", className)} />
  if (name === "xlsx") return <Table2 aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400", className)} />
  if (name === "pptx") return <Presentation aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400", className)} />
  if (name === "pdf") return <FileCheck2 aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400", className)} />
  if (name === "csv") {
    return <FileSpreadsheet aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400", className)} />
  }
  if (name === "skill-creator") {
    return <WandSparkles aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400", className)} />
  }
  if (/datos|sql|finanz|metric|kpi/.test(name)) {
    return <BarChart3 aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400", className)} />
  }
  if (/investig|apa|cita|tesis|academ/.test(name)) {
    return <BookOpen aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400", className)} />
  }
  if (/presenta|slide|pitch/.test(name)) {
    return <Presentation aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400", className)} />
  }
  if (/codigo|api|depura|git/.test(name)) {
    return <Code2 aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-zinc-700 dark:text-zinc-300", className)} />
  }
  if (/informe|acta|propuesta|documento|escritura|correo|traducc/.test(name)) {
    return <FileText aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400", className)} />
  }
  if (skill?.source === "biblioteca") {
    return <Sparkles aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-foreground/80", className)} />
  }
  return <ScrollText aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-foreground/80", className)} />
}

function subtitleFor(skills: ComposerSkills): string {
  const count = skills.selected.length
  if (count > 0) return `${count} activa${count > 1 ? "s" : ""} para el próximo mensaje`
  return "Word, Excel, PowerPoint, PDF y flujos Cowork"
}

/** Core Cowork document/data studio skills first, then custom/installed alphabetically. */
function sortSkills(list: ChatSkillSummary[]) {
  return [...list].sort((a, b) => {
    const rankA = CORE_SKILL_ORDER[a.name] ?? 100
    const rankB = CORE_SKILL_ORDER[b.name] ?? 100
    if (rankA !== rankB) return rankA - rankB
    return (a.title || a.name).localeCompare(b.title || b.name, "es")
  })
}

function SkillsList({ skills, onPicked }: { skills: ComposerSkills; onPicked?: () => void }) {
  const [query, setQuery] = React.useState("")
  const visible = sortSkills(filterSkills(skills.catalog, query))
  const atLimit = skills.selected.length >= MAX_COMPOSER_SKILLS

  return (
    <div className="chat-skills-list min-w-[17.5rem]" data-testid="chat-skills-list">
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
      <div className="chat-skills-scroll max-h-[min(21rem,54vh)] overflow-y-auto overscroll-contain py-0.5">
        {visible.map((skill) => {
          const active = skills.isSelected(skill.name)
          const displayTitle = skill.title || skill.name
          return (
            <DropdownMenuItem
              key={skill.name}
              className="chat-skill-menu-item liquid-menu-item py-2"
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
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium leading-tight text-foreground">{displayTitle}</span>
                  </div>
                  {skill.description ? (
                    <div className="mt-0.5 truncate text-[11.5px] leading-tight text-muted-foreground">{skill.description}</div>
                  ) : null}
                </div>
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
