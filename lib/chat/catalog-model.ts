export type CatalogModelLike = {
  name?: string
  provider?: string
}

const FLASH = "deepseek-v4-flash"
const PRO = "deepseek-v4-pro"

function bareModelName(name?: string): string {
  const raw = String(name || "").trim().toLowerCase()
  return raw.includes("/") ? raw.split("/").pop() || raw : raw
}

function isAllowedProvider(provider?: string): boolean {
  const p = String(provider || "").trim().toLowerCase()
  if (!p) return true
  if (/openrouter|openai|gemini|anthropic|cerebras|groq/.test(p)) return false
  return p === "deepseek"
}

function isAllowedGenerationModel(name?: string, provider?: string): boolean {
  const bare = bareModelName(name)
  if (!(bare === FLASH || bare === PRO)) return false
  return isAllowedProvider(provider)
}

/** Chat model picker: DeepSeek V4 Flash/Pro only — never OpenRouter. */
export function isAllowedCatalogGenerationModel(name?: string, provider?: string): boolean {
  return isAllowedGenerationModel(name, provider)
}

export function listDeepSeekCatalogModels<T extends CatalogModelLike>(models: T[] = []): T[] {
  if (!Array.isArray(models) || models.length === 0) return []
  return models.filter((model) => isAllowedGenerationModel(model.name, model.provider))
}

function normalizeGenerationModel(name?: string): string {
  return bareModelName(name) === PRO ? PRO : FLASH
}

function safeProvider(provider?: string, fallback = "DeepSeek"): string {
  const raw = String(provider || "").trim()
  if (raw && isAllowedProvider(raw)) return raw
  const fb = String(fallback || "").trim()
  if (fb && isAllowedProvider(fb)) return fb
  return "DeepSeek"
}

export function resolveCatalogModel(
  selectedModel: string,
  availableModels: CatalogModelLike[] = [],
  fallbackProvider = "",
): { name: string; provider: string; replaced: boolean } {
  const models = Array.isArray(availableModels)
    ? availableModels.filter((model) => model && typeof model.name === "string" && model.name.trim())
    : []
  const allowed = models.filter((model) => isAllowedGenerationModel(model.name, model.provider))

  if (isAllowedGenerationModel(selectedModel)) {
    const wanted = normalizeGenerationModel(selectedModel)
    const match = allowed.find((model) => normalizeGenerationModel(model.name) === wanted)
    if (match?.name) {
      return { name: wanted, provider: safeProvider(match.provider, fallbackProvider), replaced: false }
    }
    return { name: wanted, provider: safeProvider(fallbackProvider), replaced: false }
  }

  const flash = allowed.find((model) => normalizeGenerationModel(model.name) === FLASH)
  const pro = allowed.find((model) => normalizeGenerationModel(model.name) === PRO)
  const fallback = flash || pro
  if (fallback?.name) {
    return {
      name: normalizeGenerationModel(fallback.name),
      provider: safeProvider(fallback.provider, fallbackProvider),
      replaced: true,
    }
  }

  return { name: FLASH, provider: safeProvider(fallbackProvider), replaced: true }
}

export type GenerateRequestModel = "deepseek-v4-flash" | "deepseek-v4-pro"

export function assertGenerateRequestModel(model?: string): GenerateRequestModel {
  return bareModelName(model) === PRO ? PRO : FLASH
}
