/**
 * code-agent · model policy.
 *
 * Pure heuristics to keep the /code IDE responsive: detect "slow" models
 * (reasoning / heavy ones that buffer for tens of seconds and cause the live
 * stream to time out) and recommend a fast, streaming alternative from the
 * models the user actually has. The panel uses this to OFFER a switch — the
 * change is only applied with the user's consent.
 */

export interface ModelLike {
  name: string
  provider?: string
  displayName?: string
}

// Reasoning / heavy models: great for hard tasks, poor for interactive IDE
// iteration (long time-to-first-byte → preview stream drops).
const SLOW_PATTERNS: RegExp[] = [
  /gpt-5/i,
  /\bo1\b/i,
  /\bo3\b/i,
  /\bo4\b/i,
  /reason/i,
  /thinking/i,
  /\br1\b/i,
  /deepseek-(r|v4)/i,
  /opus/i,
]

// Fast, streaming-friendly models, best first.
const FAST_PRIORITY: RegExp[] = [
  /llama-3\.1-8b/i, // FlashGPT / Cerebras — fastest
  /cerebras/i,
  /gpt-4o-mini/i,
  /4o-mini/i,
  /gemini-[12]\.\d+-flash/i,
  /flash/i,
  /haiku/i,
  /mini/i,
]

/** True for reasoning/heavy models that are a poor fit for live IDE iteration. */
export function isSlowModel(id: string | null | undefined): boolean {
  const s = String(id || "")
  if (!s) return false
  return SLOW_PATTERNS.some((re) => re.test(s))
}

/**
 * Pick the best fast model from the user's available list, or null if none is
 * clearly better. Never returns a slow model.
 */
export function recommendFastModel<T extends ModelLike>(models: T[]): T | null {
  if (!Array.isArray(models) || models.length === 0) return null
  for (const re of FAST_PRIORITY) {
    const hit = models.find((m) => re.test(m.name) && !isSlowModel(m.name))
    if (hit) return hit
  }
  return models.find((m) => !isSlowModel(m.name)) ?? null
}
