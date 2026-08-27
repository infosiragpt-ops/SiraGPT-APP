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

function looksLikeLocalCustomModel(name?: string): boolean {
  const raw = String(name || "").trim().toLowerCase()
  if (!raw) return false
  return /\bmoondream\b/.test(raw)
    || raw.includes("ollama")
    || raw.includes("huggingface")
    || raw.includes("sira-gpt-mini")
    || raw === "siragpt mini"
}

function pickProvider(model: CatalogModelLike | undefined, fallback = "", wantedName = ""): string {
  const fromModel = String(model?.provider || "").trim()
  if (fromModel) return fromModel
  if (looksLikeLocalCustomModel(model?.name || wantedName)) return "Custom"
  const raw = String(fallback || "").trim()
  return raw || "DeepSeek"
}

/**
 * Resolve the model that will actually be sent.
 *
 * The user's picker choice always wins. A non-empty selection is never
 * rewritten to Flash / catalog[0] / cheapest — if that id cannot run,
 * generate must error on that model instead of silently swapping.
 * Empty catalog snapshots (the generate client path) keep the requested id.
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
        provider: pickProvider(match, fallbackProvider, wanted),
        replaced: false,
      }
    }
    return {
      name: wanted,
      provider: pickProvider(undefined, fallbackProvider, wanted),
      replaced: false,
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

export type PreferredModelOptions = {
  current?: string
  pinned?: string
  last?: string
}

/**
 * Pick the catalog row to show on a new / reloaded chat.
 * Current selection wins, then the pinned default, then last pick, then [0].
 */
export function pickPreferredCatalogModel(
  availableModels: CatalogModelLike[] = [],
  opts: PreferredModelOptions = {},
): { name: string; provider: string } | null {
  const models = Array.isArray(availableModels)
    ? availableModels.filter((model) => model && typeof model.name === "string" && model.name.trim())
    : []
  const find = (wanted?: string) => {
    const id = String(wanted || "").trim()
    if (!id) return undefined
    return models.find((model) => sameModel(model.name, id))
  }

  const current = String(opts.current || "").trim()
  if (current) {
    const match = find(current)
    if (match?.name) return { name: match.name, provider: pickProvider(match, "", current) }
    return { name: current, provider: pickProvider(undefined, "", current) }
  }

  const pinned = find(opts.pinned)
  if (pinned?.name) return { name: pinned.name, provider: pickProvider(pinned) }

  const last = find(opts.last)
  if (last?.name) return { name: last.name, provider: pickProvider(last) }

  const first = models[0]
  if (first?.name) return { name: first.name, provider: pickProvider(first) }
  return null
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
