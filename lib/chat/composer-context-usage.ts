export type ComposerGenerationUsage = {
  tokensIn?: number
  tokensOut?: number
  total?: number
  contextTokens?: number
  contextWindow?: number
  model?: string
  costTotalUsd?: number
  costInputUsd?: number
  costOutputUsd?: number
  costCacheReadUsd?: number
  costOriginalUsd?: number
  costAppliedUsd?: number
}

export type ComposerContextMessage = {
  role?: string
  generationUsage?: ComposerGenerationUsage | null
  metadata?: string | Record<string, unknown> | null
}

export type ComposerContextModel = {
  id?: string | null
  name?: string | null
  contextLength?: number | null
  contextWindow?: number | null
  context_length?: number | null
}

export type ComposerContextSnapshot = {
  contextTokens: number | null
  contextWindow: number | null
  percentage: number | null
  latestUsage: ComposerGenerationUsage | null
}

export function resolveDisplayTotalCost(
  usage: ComposerGenerationUsage | null | undefined,
): number | null {
  return finiteNonNegative(usage?.costAppliedUsd)
    ?? finiteNonNegative(usage?.costTotalUsd)
    ?? finiteNonNegative(usage?.costOriginalUsd)
}

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function parseMetadata(metadata: ComposerContextMessage["metadata"]): Record<string, unknown> {
  if (!metadata) return {}
  if (typeof metadata === "object") return metadata
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeStoredUsage(value: unknown): ComposerGenerationUsage | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const usage: ComposerGenerationUsage = {}
  const numberFields = [
    "tokensIn",
    "tokensOut",
    "total",
    "contextTokens",
    "contextWindow",
    "costTotalUsd",
    "costInputUsd",
    "costOutputUsd",
    "costCacheReadUsd",
    "costOriginalUsd",
    "costAppliedUsd",
  ] as const

  for (const field of numberFields) {
    const number = finiteNonNegative(raw[field])
    if (number !== null) usage[field] = number
  }
  if (typeof raw.model === "string" && raw.model.trim()) usage.model = raw.model.trim()

  return Object.keys(usage).length > 0 ? usage : null
}

export function readMessageGenerationUsage(message: ComposerContextMessage): ComposerGenerationUsage | null {
  const direct = normalizeStoredUsage(message.generationUsage)
  if (direct) return direct
  const metadata = parseMetadata(message.metadata)
  return normalizeStoredUsage(metadata.generationUsage)
}

function sameModel(
  usageModel: string | undefined,
  selectedModel: string,
  model: ComposerContextModel | null,
): boolean {
  if (!usageModel) return true
  const normalizedUsage = usageModel.trim().toLowerCase()
  const selectedIdentifiers = [selectedModel, model?.id, model?.name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase())
  return selectedIdentifiers.includes(normalizedUsage)
}

function resolveModel(
  selectedModel: string,
  availableModels: ComposerContextModel[],
): ComposerContextModel | null {
  const wanted = selectedModel.trim().toLowerCase()
  if (!wanted) return null
  return availableModels.find((model) => {
    const identifiers = [model.name, model.id]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
    return identifiers.includes(wanted)
  }) || null
}

export function deriveComposerContextSnapshot({
  messages,
  selectedModel,
  availableModels,
}: {
  messages: ComposerContextMessage[]
  selectedModel: string
  availableModels: ComposerContextModel[]
}): ComposerContextSnapshot {
  const model = resolveModel(selectedModel, availableModels)
  let latestUsage: ComposerGenerationUsage | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role || "").toUpperCase() !== "ASSISTANT") continue
    const usage = readMessageGenerationUsage(message)
    if (!usage) continue
    latestUsage = usage
    break
  }
  const matchingContextUsage = latestUsage && sameModel(latestUsage.model, selectedModel, model)
    ? latestUsage
    : null

  const contextWindow = finiteNonNegative(model?.contextLength)
    ?? finiteNonNegative(model?.contextWindow)
    ?? finiteNonNegative(model?.context_length)
    ?? finiteNonNegative(matchingContextUsage?.contextWindow)
  const contextTokens = finiteNonNegative(matchingContextUsage?.contextTokens)
  const percentage = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : null

  return {
    contextTokens,
    contextWindow,
    percentage,
    latestUsage,
  }
}

export function formatCompactTokens(value: number | null | undefined): string {
  const number = finiteNonNegative(value)
  if (number === null) return "—"
  if (number >= 1_000_000) {
    const scaled = number / 1_000_000
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}m`
  }
  if (number >= 1_000) {
    const scaled = number / 1_000
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`
  }
  return Math.round(number).toLocaleString("en-US")
}

export function formatUsd(value: number | null | undefined): string {
  const number = finiteNonNegative(value)
  if (number === null) return "—"
  const digits = number < 0.01 ? 4 : number < 1 ? 3 : 2
  return `$${number.toFixed(digits)}`
}
