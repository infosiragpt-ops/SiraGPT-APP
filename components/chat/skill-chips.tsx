"use client"

import { X } from "lucide-react"

import { SkillGlyph } from "@/components/chat/skills-menu"
import type { ComposerSkills } from "@/lib/chat/use-composer-skills"

/** Composer chips for the skills picked for the next message (claude.ai style). */
export function SkillChips({ skills }: { skills: ComposerSkills | null | undefined }) {
  if (!skills || skills.selected.length === 0) return null
  return (
    <>
      {skills.selected.map((skill) => (
        <span
          key={skill.name}
          data-testid={`chat-skill-chip-${skill.name}`}
          className="chat-active-apps-chip chat-skill-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/80 py-0 pl-2.5 pr-1.5 text-xs font-medium text-foreground shadow-sm"
          title={skill.description}
        >
          <SkillGlyph skill={skill} className="h-3.5 w-3.5" />
          <span className="max-w-[120px] truncate">{skill.title || skill.name}</span>
          <button
            type="button"
            onClick={() => skills.remove(skill.name)}
            aria-label={`Quitar la skill ${skill.title || skill.name}`}
            title={`Quitar la skill ${skill.title || skill.name}`}
            className="ml-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </>
  )
}

export default SkillChips
