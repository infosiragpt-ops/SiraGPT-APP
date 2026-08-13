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
  if (models.length === 0) {
    return { name: selectedModel, provider: fallbackProvider, replaced: false }
  }
  const match = models.find((model) => model.name === selectedModel)
  if (match?.name) {
    return { name: match.name, provider: match.provider || fallbackProvider, replaced: false }
  }
  const fallback = models[0]
  return {
    name: String(fallback.name),
    provider: fallback.provider || fallbackProvider,
    replaced: true,
  }
}
