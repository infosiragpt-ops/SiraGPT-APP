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

function sameModel(a?: string, b?: string): boolean {
  const left = String(a || "").trim().toLowerCase()
  const right = String(b || "").trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  return bareModelName(left) === bareModelName(right)
}

function pickProvider(model: CatalogModelLike | undefined, fallback = ""): string {
  const raw = String(model?.provider || fallback || "").trim()
  return raw || "DeepSeek"
}

/**
 * Resolve the model that will actually be sent.
 *
 * The user's picker choice wins. We only replace it when the selection is
 * empty or not in the catalog for this chat type (e.g. a VIDEO id on TEXT).
 * An empty catalog snapshot (the generate client path) must still honor
 * the requested id — never fail-closed to a single DeepSeek model.
 */
export function resolveCatalogModel(
  selectedModel: string,
  availableModels: CatalogModelLike[] = [],
  fallbackProvider = "",
): { name: string; provider: string; replaced: boolean } {
  const models = Array.isArray(availableModels)
    ? availableModels.filter((model) => model && typeof model.name === "string" && model.name.trim())
    : []
  const wanted = String(selectedModel || "").trim()

  if (wanted) {
    const match = models.find((model) => sameModel(model.name, wanted))
    if (match?.name) {
      return {
        name: match.name,
        provider: pickProvider(match, fallbackProvider),
        replaced: false,
      }
    }
    if (models.length === 0) {
      return {
        name: wanted,
        provider: pickProvider(undefined, fallbackProvider),
        replaced: false,
      }
    }
  }

  const fallback = models[0]
  if (fallback?.name) {
    return {
      name: fallback.name,
      provider: pickProvider(fallback, fallbackProvider),
      replaced: true,
    }
  }

  return {
    name: FLASH,
    provider: pickProvider(undefined, fallbackProvider),
    replaced: true,
  }
}

export type GenerateRequestModel = string

export function assertGenerateRequestModel(model?: string): GenerateRequestModel {
  const wanted = String(model || "").trim()
  if (!wanted) return FLASH
  const bare = bareModelName(wanted)
  if (bare === PRO) return PRO
  if (bare === FLASH) return FLASH
  return wanted
}
