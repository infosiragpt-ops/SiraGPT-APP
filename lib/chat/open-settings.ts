export const OPEN_SETTINGS_EVENT = "sira:open-settings"

export type SkillsSettingsTab = "mine" | "discover"

export type OpenSettingsDetail = {
  section?: "general" | "personalization" | "capabilities" | "skills"
  /** Ajustes → Skills tab to land on («Gestionar habilidades» / «Explorar habilidades»). */
  skillsTab?: SkillsSettingsTab
}

let pendingSkillsTab: SkillsSettingsTab | null = null

export function openSettingsSection(
  section: OpenSettingsDetail["section"] = "general",
  options: { skillsTab?: SkillsSettingsTab } = {},
) {
  if (typeof window === "undefined") return
  pendingSkillsTab = options.skillsTab ?? null
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
    detail: { section, skillsTab: options.skillsTab },
  }))
}

/** The tab requested by the last openSettingsSection("skills", …) call, read once. */
export function consumeSkillsTab(): SkillsSettingsTab | null {
  const tab = pendingSkillsTab
  pendingSkillsTab = null
  return tab
}
