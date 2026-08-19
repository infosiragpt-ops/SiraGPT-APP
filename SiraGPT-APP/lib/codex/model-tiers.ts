// codex/model-tiers — the "Power" selector tiers (feature 12). Three tiers map
// to model classes; the tier travels in POST /api/codex/.../runs { tier } and
// the backend resolves tier→model. The UI shows a relative cost indicator.
//
// Pure + testable. The backend is the source of truth for the actual model;
// this only drives the dropdown labels + the cost hint.

export type CodexTier = 'eco' | 'standard' | 'power'

export interface TierDescriptor {
  id: CodexTier
  label: string
  description: string
  cost: 'free' | '$' | '$$$'
  free: boolean
}

export const TIERS: Record<CodexTier, TierDescriptor> = {
  eco: { id: 'eco', label: 'Eco', description: 'Rápido y gratis (FlashGPT)', cost: 'free', free: true },
  standard: { id: 'standard', label: 'Estándar', description: 'Equilibrio calidad/costo', cost: '$', free: false },
  power: { id: 'power', label: 'Power', description: 'Máxima capacidad', cost: '$$$', free: false },
}

export const TIER_ORDER: CodexTier[] = ['eco', 'standard', 'power']
export const DEFAULT_TIER: CodexTier = 'eco'

export function isTier(value: unknown): value is CodexTier {
  return typeof value === 'string' && (value === 'eco' || value === 'standard' || value === 'power')
}

/** Resolve a tier descriptor, falling back to Eco for an unknown value. */
export function resolveTier(value: unknown): TierDescriptor {
  return isTier(value) ? TIERS[value] : TIERS[DEFAULT_TIER]
}

/** The relative cost label shown in the dropdown. */
export function costLabel(tier: CodexTier): string {
  return TIERS[tier]?.cost ?? '$'
}

const FREE_MODEL_RE = /cerebras|flashgpt|free\s*ia|gema|llama|gpt-oss|glm/i
const POWER_MODEL_RE = /anthropic|claude|opus|sonnet|gpt-5|openai/i

/**
 * Map the chat's model-picker choice (catalog provider + model id) to a Codex
 * tier — the runs API speaks eco|standard|power, never provider names. Free
 * catalog entries stay Eco; Claude/OpenAI-class choices get Power (the backend
 * resolves Power → its strongest engine); anything else paid is Estándar.
 */
export function tierForModelChoice(provider?: string | null, modelName?: string | null): CodexTier {
  const haystack = `${provider || ''} ${modelName || ''}`.trim()
  if (!haystack) return DEFAULT_TIER
  if (FREE_MODEL_RE.test(haystack)) return 'eco'
  if (POWER_MODEL_RE.test(haystack)) return 'power'
  return 'standard'
}
