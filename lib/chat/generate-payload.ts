import { resolveCatalogModel } from "./catalog-model"
import { clampDeepSeekModel } from "../sse-client"

/**
 * Canonical generate payload (AGENTS.md §28).
 * The picker model keeps its own API. Leftover mixer ids may clamp to
 * Flash/Pro; only then does the provider become DeepSeek.
 */
export function lockGeneratePayload(
  model?: string | null,
  provider?: string | null,
  catalogNames?: string[],
): { model: string; provider: string } {
  const resolved = resolveCatalogModel(String(model || ""), [], String(provider || ""))
  const lockedModel = clampDeepSeekModel(resolved.name, catalogNames) || resolved.name
  const clampedToDeepSeek =
    lockedModel !== resolved.name && /deepseek-v4-(flash|pro)/i.test(lockedModel)
  return {
    model: lockedModel,
    provider: clampedToDeepSeek ? "DeepSeek" : resolved.provider,
  }
}

export function withLockedGenerateModel<T extends { model?: string | null; provider?: string | null }>(
  data: T,
  catalogNames?: string[],
): T & { model: string; provider: string } {
  const locked = lockGeneratePayload(data.model, data.provider, catalogNames)
  return { ...data, model: locked.model, provider: locked.provider }
}
