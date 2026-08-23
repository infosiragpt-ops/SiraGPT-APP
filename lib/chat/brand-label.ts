/**
 * Chat UI brand aliases.
 *
 * DeepSeek (and leftover OpenAI ids) stay on the wire / backend only.
 * The composer, action rail, and "respondido con" line must never render
 * a raw model_id such as "Deepseek V4 PRO" or "gpt-4o".
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
 * Map any model descriptor to the public chat brand.
 * Unknown / non-DeepSeek leftovers collapse to Sira Rápido (the default
 * generation model) so the UI never leaks a vendor id.
 */
export function brandModelLabel(source: BrandLabelSource): string {
  if (isProGenerationModel(source)) return SIRA_PRO_LABEL
  if (isFlashGenerationModel(source)) return SIRA_RAPIDO_LABEL

  const raw = typeof source === "string"
    ? source
    : firstString(source?.displayName, source?.name)
  if (!raw) return SIRA_RAPIDO_LABEL
  if (looksLikeRawVendorModelId(raw)) return SIRA_RAPIDO_LABEL
  return raw
}
