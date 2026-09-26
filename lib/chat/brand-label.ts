/**
 * Chat UI labels.
 *
 * DeepSeek V4 Flash/Pro show their original names — «DeepSeek V4 Flash» /
 * «DeepSeek V4 Pro», provider «DeepSeek» (decisión de producto 2026-09-26).
 * The former Sira aliases (Sira Rápido / Sira Pro) are still ACCEPTED as input
 * (saved picks, stale catalog rows, metadata of older messages) and resolve to
 * the original names; they are never displayed. Raw ids (`deepseek-v4-flash`,
 * `deepseek/…`) never reach the UI.
 * Every other catalog model keeps its display name so the picker can show
 * GPT, Claude, Grok, Kimi, etc. instead of collapsing everything to one label.
 */

export const DEEPSEEK_PRO_LABEL = "DeepSeek V4 Pro"
export const DEEPSEEK_FLASH_LABEL = "DeepSeek V4 Flash"
export const DEEPSEEK_PROVIDER_LABEL = "DeepSeek"

// Legacy Sira aliases are matched here so they keep resolving to the pair.
const PRO_RE =
  /(?:deepseek[-/_\s]?v?4[-/_\s]?pro|deepseek\s*v4\s*pro|v4[-_\s]?pro(?:\s+live)?|\bsira[-_\s]?pro\b)/i
const FLASH_RE =
  /(?:deepseek[-/_\s]?v?4[-/_\s]?flash|deepseek\s*v4\s*flash|v4[-_\s]?flash|\bsira[-_\s]?r[aá]pido\b)/i
// DeepSeek is a public name now; only its raw id forms (deepseek-chat,
// deepseek/…) count as a vendor id leak.
const RAW_VENDOR_RE = /^deepseek$|deepseek[-_/:.]|openai|gpt-?4|gpt-?5|o1\b|o3\b|o4-mini|ollama|huggingface|moondream|gemma4|gemma\s*4\b/i
const HIDDEN_PROVIDER_RE = /^(ollama|huggingface|moondream|gemma4)$/i
const DEEPSEEK_RAW_ID_RE = /^(?:deepseek\/)?deepseek[-_](.+)$/i

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

export function isDeepSeekProductLabel(label: string): boolean {
  const trimmed = String(label || "").trim()
  return trimmed === DEEPSEEK_PRO_LABEL || trimmed === DEEPSEEK_FLASH_LABEL
}

export function looksLikeRawVendorModelId(label: string): boolean {
  const trimmed = String(label || "").trim()
  if (!trimmed) return false
  if (isDeepSeekProductLabel(trimmed)) return false
  return RAW_VENDOR_RE.test(trimmed)
}

/**
 * Human name for a raw DeepSeek id other than the V4 pair:
 * `deepseek-reasoner` → «DeepSeek Reasoner». Not a DeepSeek id → "".
 */
export function prettifyDeepSeekModelId(raw: string): string {
  const match = String(raw || "").trim().match(DEEPSEEK_RAW_ID_RE)
  if (!match) return ""
  const rest = match[1]
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => (/^v\d/i.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1)))
    .join(" ")
  return rest ? `${DEEPSEEK_PROVIDER_LABEL} ${rest}` : DEEPSEEK_PROVIDER_LABEL
}

function isExplicitProductLabel(label: string): boolean {
  const trimmed = String(label || "").trim()
  if (!trimmed) return false
  if (isDeepSeekProductLabel(trimmed)) return false
  if (isProGenerationModel(trimmed) || isFlashGenerationModel(trimmed)) return false
  if (looksLikeRawVendorModelId(trimmed)) return false
  return true
}

/**
 * Map a model descriptor to the picker / composer label.
 * DeepSeek Flash/Pro (and their legacy Sira aliases) → original names. An
 * explicit catalog displayName (e.g. SiraGPT Mini) always wins so raw ids
 * never leak into the pill.
 */
export function brandModelLabel(source: BrandLabelSource): string {
  const display = typeof source === "string" ? "" : firstString(source?.displayName)
  if (isExplicitProductLabel(display)) return cleanCatalogLabel(display)

  if (isProGenerationModel(source)) return DEEPSEEK_PRO_LABEL
  if (isFlashGenerationModel(source)) return DEEPSEEK_FLASH_LABEL

  const raw = typeof source === "string"
    ? source
    : firstString(source?.displayName, source?.name)
  if (!raw) return DEEPSEEK_FLASH_LABEL
  if (looksLikeRawVendorModelId(raw) && display && isExplicitProductLabel(display)) return cleanCatalogLabel(display)
  return hideForbiddenVendorLabel(raw)
}

function hideForbiddenVendorLabel(label: string): string {
  const trimmed = String(label || "").trim()
  if (!trimmed) return DEEPSEEK_FLASH_LABEL
  if (/\bmoondream\b/i.test(trimmed)) return "SiraGPT Mini"
  if (/\bgemma4\b/i.test(trimmed) || /\bgemma\s*4\b/i.test(trimmed)) return "SiraGPT Mini"
  if (/^sira[- ]?mini$/i.test(trimmed) || /^siragpt[- ]?mini$/i.test(trimmed)) return "SiraGPT Mini"
  if (/ollama|huggingface/i.test(trimmed)) return "Sira"
  const deepseek = prettifyDeepSeekModelId(trimmed)
  if (deepseek) return deepseek
  if (/^deepseek$/i.test(trimmed)) return DEEPSEEK_PROVIDER_LABEL
  return cleanCatalogLabel(trimmed)
}

/**
 * OpenRouter-synced rows arrive as "Vendor: Model (free)". The picker shows
 * the model name only — the vendor prefix and pricing suffix are catalog
 * noise, not product copy.
 */
function cleanCatalogLabel(label: string): string {
  const withoutSuffix = label.replace(/\s*\((?:free|gratis|beta)\)\s*$/i, "").trim()
  const prefixed = withoutSuffix.match(/^[^:/]{2,40}:\s+(.+)$/)
  const cleaned = (prefixed ? prefixed[1] : withoutSuffix).trim()
  return cleaned || label
}

/**
 * Provider / attribution line for chat chrome.
 * DeepSeek Flash/Pro show «DeepSeek». Hidden local vendors (Ollama,
 * HuggingFace, moondream) are not shown — the product label is enough.
 */
export function brandProviderLabel(source: BrandLabelSource): string {
  if (isProGenerationModel(source) || isFlashGenerationModel(source)) return DEEPSEEK_PROVIDER_LABEL
  if (!source) return "Sira"
  if (typeof source === "string") {
    const trimmed = source.trim()
    if (/^deepseek$/i.test(trimmed)) return DEEPSEEK_PROVIDER_LABEL
    if (HIDDEN_PROVIDER_RE.test(trimmed)) return "Sira"
    return trimmed || "Sira"
  }
  const provider = firstString(source.provider)
  if (/^deepseek$/i.test(provider)) return DEEPSEEK_PROVIDER_LABEL
  if (!provider || HIDDEN_PROVIDER_RE.test(provider)) return "Sira"
  return provider
}
