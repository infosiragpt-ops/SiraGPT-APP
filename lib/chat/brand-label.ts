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
const RAW_VENDOR_RE = /deepseek|openai|gpt-?4|gpt-?5|o1\b|o3\b|o4-mini|ollama|huggingface|moondream|gemma4|gemma\s*4\b/i
const HIDDEN_PROVIDER_RE = /^(deepseek|ollama|huggingface|moondream|gemma4)$/i

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

function isExplicitProductLabel(label: string): boolean {
  const trimmed = String(label || "").trim()
  if (!trimmed) return false
  if (trimmed === SIRA_PRO_LABEL || trimmed === SIRA_RAPIDO_LABEL) return false
  if (isProGenerationModel(trimmed) || isFlashGenerationModel(trimmed)) return false
  if (looksLikeRawVendorModelId(trimmed)) return false
  return true
}

/**
 * Map a model descriptor to the picker / composer label.
 * DeepSeek Flash/Pro → Sira aliases. An explicit catalog displayName
 * (e.g. SiraGPT Mini) always wins so raw ids never leak into the pill.
 */
export function brandModelLabel(source: BrandLabelSource): string {
  const display = typeof source === "string" ? "" : firstString(source?.displayName)
  if (isExplicitProductLabel(display)) return display

  if (isProGenerationModel(source)) return SIRA_PRO_LABEL
  if (isFlashGenerationModel(source)) return SIRA_RAPIDO_LABEL

  const raw = typeof source === "string"
    ? source
    : firstString(source?.displayName, source?.name)
  if (!raw) return ""
  if (looksLikeRawVendorModelId(raw) && display && isExplicitProductLabel(display)) return display
  return hideForbiddenVendorLabel(raw)
}

function hideForbiddenVendorLabel(label: string): string {
  const trimmed = String(label || "").trim()
  if (!trimmed) return ""
  if (/\bmoondream\b/i.test(trimmed)) return "SiraGPT Mini"
  if (/\bgemma4\b/i.test(trimmed) || /\bgemma\s*4\b/i.test(trimmed)) return "SiraGPT Mini"
  if (/^sira[- ]?mini$/i.test(trimmed) || /^siragpt[- ]?mini$/i.test(trimmed)) return "SiraGPT Mini"
  if (/ollama|huggingface/i.test(trimmed)) return "Sira"
  if (/^deepseek\b/i.test(trimmed)) return SIRA_RAPIDO_LABEL
  return trimmed
}

/**
 * Provider / attribution line for chat chrome.
 * DeepSeek Flash/Pro stay "Sira". Hidden local vendors (Ollama,
 * HuggingFace, moondream) are not shown — the product label is enough.
 */
export function brandProviderLabel(source: BrandLabelSource): string {
  if (isProGenerationModel(source) || isFlashGenerationModel(source)) return "Sira"
  if (!source) return "Sira"
  if (typeof source === "string") {
    const trimmed = source.trim()
    if (HIDDEN_PROVIDER_RE.test(trimmed)) return "Sira"
    return trimmed || "Sira"
  }
  const provider = firstString(source.provider)
  if (!provider || HIDDEN_PROVIDER_RE.test(provider)) return "Sira"
  return provider
}
