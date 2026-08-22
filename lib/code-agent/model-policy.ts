/**
 * code-agent · model policy.
 * WAVE1 + ola-200 fail-closed: generation recommend is DeepSeek V4 Flash / Pro only.
 */

export interface ModelLike {
  name: string
  provider?: string
  displayName?: string
}

const SLOW_PATTERNS: RegExp[] = [
  /gpt-5/i,
  /\\bo1\\b/i,
  /\\bo3\\b/i,
  /\\bo4\\b/i,
  /reason/i,
  /thinking/i,
  /\\br1\\b/i,
  /deepseek-r/i,
  /opus/i,
]

const FAST_PRIORITY: RegExp[] = [
  /deepseek-v4-flash/i,
  /deepseek-v4-pro/i,
]

function isAllowedGenerationModel(id: string, provider?: string): boolean {
  if (!(/deepseek-v4-flash/i.test(id) || /deepseek-v4-pro/i.test(id))) return false
  const p = String(provider || "").trim().toLowerCase()
  if (!p) return true
  if (/openrouter|openai|gemini|anthropic|cerebras|groq/.test(p)) return false
  return p === "deepseek"
}

export function isSlowModel(id: string | null | undefined): boolean {
  const s = String(id || "")
  if (!s) return false
  if (/deepseek-v4/i.test(s) && !/deepseek-r/i.test(s)) return false
  return SLOW_PATTERNS.some((re) => re.test(s))
}

export function recommendFastModel<T extends ModelLike>(models: T[]): T | null {
  if (!Array.isArray(models) || models.length === 0) return null
  for (const re of FAST_PRIORITY) {
    const hit = models.find((m) => re.test(m.name) && isAllowedGenerationModel(m.name, m.provider) && !isSlowModel(m.name))
    if (hit) return hit
  }
  return null
}
