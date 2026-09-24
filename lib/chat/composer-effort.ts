/**
 * Composer reasoning effort — the five levels shown at the foot of the model
 * menu (Claude-style "Esfuerzo" submenu).
 *
 * The value is what the client sends as `reasoningEffort`; the backend
 * normalizes it in `reasoning-orchestrator.js` (EFFORT_ALIASES) into the
 * compute plan AND the provider's native thinking knob (reasoning_effort /
 * reasoning.effort / DeepSeek thinking) where the model supports one.
 */

export type ComposerEffortValue = "Bajo" | "Medio" | "Alto" | "Extra" | "Max"

export type ComposerEffortLevel = {
  value: ComposerEffortValue
  label: string
  isDefault?: boolean
  heavyUsage?: boolean
}

export const COMPOSER_EFFORT_LEVELS: readonly ComposerEffortLevel[] = [
  { value: "Bajo", label: "Bajo" },
  { value: "Medio", label: "Medio", isDefault: true },
  { value: "Alto", label: "Alto" },
  { value: "Extra", label: "Extra" },
  { value: "Max", label: "Máx", heavyUsage: true },
] as const

export const DEFAULT_COMPOSER_EFFORT: ComposerEffortValue = "Medio"

export const COMPOSER_EFFORT_HELP =
  "Un mayor esfuerzo significa respuestas más completas, pero lleva más tiempo y consume tus límites más rápido."

export const COMPOSER_EFFORT_STORAGE_KEY = "sira:composer:effort"
// Marks the stored value as written by the five-level scale. Before it, the
// composer stored "Extra" for High and "Max" for Extra high.
export const COMPOSER_EFFORT_SCALE_KEY = "sira:composer:effort-scale"
export const COMPOSER_EFFORT_SCALE = "5"

const VALUES = new Set<string>(COMPOSER_EFFORT_LEVELS.map((level) => level.value))

export function normalizeComposerEffort(value: unknown): ComposerEffortValue {
  const raw = typeof value === "string" ? value.trim() : ""
  if (VALUES.has(raw)) return raw as ComposerEffortValue
  const key = raw.toLowerCase()
  if (key === "low" || key === "bajo") return "Bajo"
  if (key === "medium" || key === "medio") return "Medio"
  if (key === "high" || key === "alto") return "Alto"
  if (key === "xhigh" || key === "extra") return "Extra"
  if (key === "max" || key === "máx" || key === "maximo" || key === "máximo") return "Max"
  return DEFAULT_COMPOSER_EFFORT
}

/** Maps a value stored by the four-stop slider onto the five-level scale. */
export function migrateStoredComposerEffort(value: unknown, scale: unknown): ComposerEffortValue {
  if (scale === COMPOSER_EFFORT_SCALE) return normalizeComposerEffort(value)
  const raw = typeof value === "string" ? value.trim() : ""
  if (raw === "Extra") return "Alto"
  if (raw === "Max") return "Extra"
  return normalizeComposerEffort(raw)
}

export function composerEffortLabel(value: unknown): string {
  const normalized = normalizeComposerEffort(value)
  return COMPOSER_EFFORT_LEVELS.find((level) => level.value === normalized)?.label || "Medio"
}

type EffortModel = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
  type?: string | null
} | null | undefined

/**
 * Decision models (TypeSafe Jev) return typed judgments, not free-form
 * reasoning, and media models take no reasoningEffort: neither gets the row.
 */
export function modelSupportsComposerEffort(model: EffortModel): boolean {
  if (!model) return true
  const type = String(model.type || "").toUpperCase()
  if (/^(IMAGE|VIDEO|AUDIO|MUSIC|VOICE)$/.test(type)) return false
  const hay = `${model.provider || ""} ${model.name || ""} ${model.displayName || ""}`.toLowerCase()
  return !/typesafe|\bjev\b/.test(hay)
}
