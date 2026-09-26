export const OPEN_SETTINGS_EVENT = "sira:open-settings"

export type OpenSettingsDetail = {
  section?: "general" | "personalization" | "capabilities"
}

export function openSettingsSection(section: OpenSettingsDetail["section"] = "general") {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
    detail: { section },
  }))
}
