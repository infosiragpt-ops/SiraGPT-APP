/**
 * Cross-surface signals for Agent Skills (claude.ai style):
 *
 *  - `sira:skills-changed` — Ajustes → Skills created, installed, switched
 *    off or deleted a skill; the composer reloads «+ → Skills» and «/».
 *  - «Probar» — Descubrir hands a skill to the chat: it is stored for the
 *    next composer mount (the chat may not be mounted yet) and also
 *    announced live for an already-open composer.
 */

import type { ChatSkillSummary } from "@/lib/api"

export const SKILLS_CHANGED_EVENT = "sira:skills-changed"
export const TRY_SKILL_EVENT = "sira:try-skill"
const TRY_SKILL_KEY = "sira:try-skill"
const TRY_SKILL_TTL_MS = 5 * 60 * 1000

export function emitSkillsChanged() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
}

export function requestTrySkill(skill: ChatSkillSummary) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(TRY_SKILL_KEY, JSON.stringify({ skill, at: Date.now() }))
  } catch {
    /* private mode: the live event below still reaches an open composer */
  }
  window.dispatchEvent(new CustomEvent<ChatSkillSummary>(TRY_SKILL_EVENT, { detail: skill }))
}

/** Read and clear a pending «Probar» handoff (null when none or stale). */
export function consumeTrySkill(now = Date.now()): ChatSkillSummary | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(TRY_SKILL_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(TRY_SKILL_KEY)
    const parsed = JSON.parse(raw) as { skill?: ChatSkillSummary; at?: number }
    if (!parsed?.skill?.name || typeof parsed.at !== "number" || now - parsed.at > TRY_SKILL_TTL_MS) return null
    return parsed.skill
  } catch {
    return null
  }
}

/** Client copy of the server's SKILL.md export, for «Descargar». */
export function skillToMarkdown(skill: { name: string; description?: string; body?: string }): string {
  const description = String(skill.description || "").replace(/\n/g, " ")
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${String(skill.body || "").trim()}\n`
}

export const SKILL_NEW_CHAT_EVENT = "sira:skill-new-chat"

/**
 * «Probar» / «Crear con SiraGPT»: close Ajustes, open a fresh chat and put
 * the skill in the composer (the sidebar owns both the dialog and new chat).
 */
export function startChatWithSkill(skill: ChatSkillSummary) {
  if (typeof window === "undefined") return
  requestTrySkill(skill)
  window.dispatchEvent(new CustomEvent<ChatSkillSummary>(SKILL_NEW_CHAT_EVENT, { detail: skill }))
}
