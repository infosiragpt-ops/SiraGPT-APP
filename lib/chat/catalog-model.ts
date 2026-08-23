import {
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  isAllowedGenerationModel,
  isAllowedGenerateProvider,
  normalizeGenerationModel,
  safeGenerateProvider,
  type LockedGenerateModel,
} from "../generation-model-lock"

export type CatalogModelLike = {
  name?: string
  provider?: string
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
      return { name: wanted, provider: safeGenerateProvider(match.provider, fallbackProvider), replaced: false }
    }
    return { name: wanted, provider: safeGenerateProvider(fallbackProvider), replaced: false }
  }

  const flash = allowed.find((model) => normalizeGenerationModel(model.name) === DEEPSEEK_FLASH)
  const pro = allowed.find((model) => normalizeGenerationModel(model.name) === DEEPSEEK_PRO)
  const fallback = flash || pro
  if (fallback?.name) {
    return {
      name: normalizeGenerationModel(fallback.name),
      provider: safeGenerateProvider(fallback.provider, fallbackProvider),
      replaced: true,
    }
  }

  return { name: DEEPSEEK_FLASH, provider: safeGenerateProvider(fallbackProvider), replaced: true }
}

export type GenerateRequestModel = LockedGenerateModel

export function assertGenerateRequestModel(model?: string): GenerateRequestModel {
  return normalizeGenerationModel(model)
}

export { isAllowedGenerateProvider, isAllowedGenerationModel }
