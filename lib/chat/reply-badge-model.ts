import {
  SIRA_PRO_LABEL,
  SIRA_RAPIDO_LABEL,
  brandModelLabel,
  isFlashGenerationModel,
  isProGenerationModel,
  looksLikeRawVendorModelId,
  type BrandLabelSource,
} from "./brand-label"
import { readMessageGenerationUsage } from "./composer-context-usage"

const VENDOR_PREFIX_RE = /^(x-ai|xai|anthropic|google|openai|moonshotai|meta|z-ai|qwen|cohere|mistralai|nousresearch)\//i
const FORBIDDEN_UI_RE = /openrouter|deepseek/i
const RAW_ID_RE = /[\/:]/

export type ReplyBadgeCatalogModel = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
}

export type ReplyBadgeMessage = {
  model?: BrandLabelSource
  generationUsage?: { model?: string } | null
  metadata?: string | Record<string, unknown> | null
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function parseMetadata(metadata: ReplyBadgeMessage["metadata"]): Record<string, unknown> {
  if (!metadata) return {}
  if (typeof metadata === "object") return metadata
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function versionToken(id: string): string {
  const match = String(id || "").toLowerCase().match(/(\d+(?:\.\d+)+)/)
  return match ? match[1] : ""
}

function sameModelId(a?: string | null, b?: string | null): boolean {
  const left = String(a || "").trim().toLowerCase()
  const right = String(b || "").trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  const leftVersion = versionToken(left)
  const rightVersion = versionToken(right)
  // DB passthrough grok-4.5 must not collapse onto curated Grok 4.2 / grok-4.20.
  if (leftVersion && rightVersion && leftVersion !== rightVersion) return false
  const bare = (value: string) => (value.includes("/") ? value.split("/").pop() || value : value)
  return bare(left) === bare(right)
}

function titleCaseModelToken(token: string): string {
  if (/^\d/.test(token)) return token
  if (/^(gpt|okr|tts|stt|llm)$/i.test(token)) return token.toUpperCase()
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * Human picker-style label from a catalog id. Never returns DeepSeek,
 * OpenRouter, or a raw vendor slug (`x-ai/…`). Empty / unknown → "".
 */
export function prettifyPickedModelLabel(raw: string): string {
  const trimmed = String(raw || "").trim()
  if (!trimmed) return ""
  if (isProGenerationModel(trimmed)) return SIRA_PRO_LABEL
  if (isFlashGenerationModel(trimmed)) return SIRA_RAPIDO_LABEL
  if (FORBIDDEN_UI_RE.test(trimmed) && !isFlashGenerationModel(trimmed) && !isProGenerationModel(trimmed)) {
    return ""
  }

  const stripped = trimmed.replace(VENDOR_PREFIX_RE, "").trim()
  if (!stripped || FORBIDDEN_UI_RE.test(stripped)) return ""
  if (!RAW_ID_RE.test(stripped) && !/[-_]/.test(stripped) && /\s/.test(stripped)) {
    return looksLikeRawVendorModelId(stripped) ? "" : stripped
  }

  const pretty = stripped
    .split(/[-_]+/)
    .filter(Boolean)
    .map(titleCaseModelToken)
    .join(" ")
  if (!pretty || looksLikeRawVendorModelId(pretty) || FORBIDDEN_UI_RE.test(pretty)) return ""
  return pretty
}

export function resolveCatalogDisplayName(
  modelId: string,
  catalog: ReplyBadgeCatalogModel[] = [],
): string {
  const wanted = String(modelId || "").trim()
  if (!wanted) return ""
  const match = catalog.find((row) => (
    sameModelId(row.name, wanted) || sameModelId(row.displayName, wanted)
  ))
  const display = firstString(match?.displayName)
  if (display && !looksLikeRawVendorModelId(display) && !FORBIDDEN_UI_RE.test(display)) {
    return display
  }
  return prettifyPickedModelLabel(wanted)
}

function sourceModelId(source: BrandLabelSource): string {
  if (!source) return ""
  if (typeof source === "string") return source.trim()
  return firstString(source.name, source.displayName)
}

/**
 * Label shown under an assistant reply. Matches the composer picker:
 * Grok → Grok, Claude → Claude. Only in-house DeepSeek Flash/Pro keep
 * Sira Rápido / Sira Pro. Missing model → no badge (never invent Sira Rápido).
 */
export function resolveReplyBadgeLabel(
  message: ReplyBadgeMessage | null | undefined,
  catalog: ReplyBadgeCatalogModel[] = [],
): string {
  const usage = message ? readMessageGenerationUsage(message) : null
  const meta = parseMetadata(message?.metadata)
  const pickerFromMeta = firstString(meta.pickerModel)
  const pickerDisplay = firstString(meta.pickerDisplayName)
  const explicit = message?.model
  const modelId = firstString(
    typeof explicit === "string" ? explicit : sourceModelId(explicit),
    usage?.model,
    pickerFromMeta,
  )
  if (!modelId && !pickerDisplay && !(explicit && typeof explicit === "object" && explicit.displayName)) {
    return ""
  }

  const display = firstString(
    typeof explicit === "object" && explicit ? explicit.displayName : "",
    pickerDisplay,
    resolveCatalogDisplayName(modelId || pickerDisplay, catalog),
  )
  const branded = brandModelLabel({
    name: modelId || display,
    displayName: display || undefined,
    provider: typeof explicit === "object" && explicit ? explicit.provider : undefined,
  })
  if (!branded || branded === SIRA_RAPIDO_LABEL) {
    if (!modelId || isFlashGenerationModel({ name: modelId, displayName: display })) {
      return isFlashGenerationModel({ name: modelId, displayName: display }) ? SIRA_RAPIDO_LABEL : ""
    }
    if (isProGenerationModel({ name: modelId, displayName: display })) return SIRA_PRO_LABEL
    return display || prettifyPickedModelLabel(modelId)
  }
  if (FORBIDDEN_UI_RE.test(branded) || looksLikeRawVendorModelId(branded) || RAW_ID_RE.test(branded)) {
    return display || prettifyPickedModelLabel(modelId)
  }
  return branded
}

export function resolvePickerBadgeSource(
  selectedModel: string,
  catalog: ReplyBadgeCatalogModel[] = [],
  provider = "",
): { name: string; displayName: string; provider: string } {
  const name = String(selectedModel || "").trim()
  const match = catalog.find((row) => sameModelId(row.name, name) || sameModelId(row.displayName, name))
  return {
    name: firstString(match?.name, name),
    displayName: firstString(match?.displayName, resolveCatalogDisplayName(name, catalog)),
    provider: firstString(match?.provider, provider),
  }
}
