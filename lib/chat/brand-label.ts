/**
 * Chat UI labels.
 *
 * DeepSeek V4 Flash/Pro keep Sira brand aliases (Sira Rápido / Sira Pro).
 * Every other catalog model keeps its display name so the picker can show
 * GPT, Claude, Grok, Kimi, etc. instead of collapsing everything to one label.
 */

export const SIRA_PRO_LABEL = "Sira Pro"
export const SIRA_RAPIDO_LABEL = "Sira Rápido"

const PRO_RE =
  /(?:deepseek[-/_\s]?v?4[-/_\s]?pro|deepseek\s*v4\s*pro|v4[-_\s]?pro(?:\s+live)?)/i
const FLASH_RE =
  /(?:deepseek[-/_\s]?v?4[-/_\s]?flash|deepseek\s*v4\s*flash|v4[-_\s]?flash)/i
const RAW_VENDOR_RE = /deepseek|openai|gpt-?4|gpt-?5|o1\b|o3\b|o4-mini/i

export type BrandLabelSource = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
} | string | null | undefined

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

export function collectModelSearchText(source: BrandLabelSource): string {
  if (!source) return ""
  if (typeof source === "string") return source.trim()
  return [source.displayName, source.name, source.provider]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
}

export function isProGenerationModel(source: BrandLabelSource): boolean {
  const hay = collectModelSearchText(source)
  if (!hay) return false
  if (FLASH_RE.test(hay) && !PRO_RE.test(hay)) return false
  return PRO_RE.test(hay)
}

export function isFlashGenerationModel(source: BrandLabelSource): boolean {
  const hay = collectModelSearchText(source)
  if (!hay) return false
  if (PRO_RE.test(hay) && !FLASH_RE.test(hay)) return false
  return FLASH_RE.test(hay)
}

export function looksLikeRawVendorModelId(label: string): boolean {
  const trimmed = String(label || "").trim()
  if (!trimmed) return false
  if (trimmed === SIRA_PRO_LABEL || trimmed === SIRA_RAPIDO_LABEL) return false
  return RAW_VENDOR_RE.test(trimmed)
}

/**
 * Map a model descriptor to the picker / composer label.
 * DeepSeek Flash/Pro → Sira aliases. Everything else keeps its catalog name.
 */
export function brandModelLabel(source: BrandLabelSource): string {
  if (isProGenerationModel(source)) return SIRA_PRO_LABEL
  if (isFlashGenerationModel(source)) return SIRA_RAPIDO_LABEL

  const raw = typeof source === "string"
    ? source
    : firstString(source?.displayName, source?.name)
  if (!raw) return SIRA_RAPIDO_LABEL
  return raw
}

/**
 * Provider / attribution line for chat chrome.
 * DeepSeek Flash/Pro stay "Sira". Other vendors keep their provider name
 * so GPT/Claude/Grok rows are distinguishable.
 */
export function brandProviderLabel(source: BrandLabelSource): string {
  if (isProGenerationModel(source) || isFlashGenerationModel(source)) return "Sira"
  if (!source) return "Sira"
  if (typeof source === "string") {
    const trimmed = source.trim()
    if (/^deepseek$/i.test(trimmed)) return "Sira"
    return trimmed || "Sira"
  }
  return firstString(source.provider) || "Sira"
}
