/**
 * DeepSeek-only generate lock — single source of truth for chat + /code pickers.
 *
 * Catalog pages may still list OpenRouter slugs. Generate clients and pickers
 * must never route those slugs. Do not add OpenRouter clients here.
 */

export const DEEPSEEK_FLASH = "deepseek-v4-flash"
export const DEEPSEEK_PRO = "deepseek-v4-pro"

export const FORBIDDEN_GENERATE_PROVIDER_RE =
  /openrouter|openai|gemini|anthropic|cerebras|groq/i

export type LockedGenerateModel = typeof DEEPSEEK_FLASH | typeof DEEPSEEK_PRO

export function bareModelName(name?: string): string {
  const raw = String(name || "").trim().toLowerCase()
  return raw.includes("/") ? raw.split("/").pop() || raw : raw
}

export function isAllowedGenerateProvider(provider?: string): boolean {
  const p = String(provider || "").trim().toLowerCase()
  if (!p) return true
  if (FORBIDDEN_GENERATE_PROVIDER_RE.test(p)) return false
  return p === "deepseek"
}

export function isAllowedGenerationModel(name?: string, provider?: string): boolean {
  const raw = String(name || "")
  const bare = bareModelName(raw)
  const allowedId =
    bare === DEEPSEEK_FLASH ||
    bare === DEEPSEEK_PRO ||
    /deepseek-v4-flash/i.test(raw) ||
    /deepseek-v4-pro/i.test(raw)
  if (!allowedId) return false
  return isAllowedGenerateProvider(provider)
}

export function normalizeGenerationModel(name?: string): LockedGenerateModel {
  return bareModelName(name) === DEEPSEEK_PRO ? DEEPSEEK_PRO : DEEPSEEK_FLASH
}

export function safeGenerateProvider(provider?: string, fallback = "DeepSeek"): string {
  const raw = String(provider || "").trim()
  if (raw && isAllowedGenerateProvider(raw)) return raw
  const fb = String(fallback || "").trim()
  if (fb && isAllowedGenerateProvider(fb)) return fb
  return "DeepSeek"
}
