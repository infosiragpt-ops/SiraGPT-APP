/**
 * Phone-only /code chrome helpers (Grok Bot mobile chat).
 * Activate at max-width 768. Desktop /code stays on its own lock.
 */

export const CODE_MOBILE_GROK_MAX_PX = 768
export const CODE_MOBILE_GROK_MEDIA = `(max-width: ${CODE_MOBILE_GROK_MAX_PX - 1}px)`

export function askAgentPlaceholder(agentName?: string | null): string {
  const name = String(agentName || "").trim() || "Agent"
  return `Ask ${name}`
}

export function agentInitials(name?: string | null): string {
  const source = String(name || "").trim() || "A"
  const parts = source.split(/\s+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "")
  return letters.join("") || "A"
}

export function isCodeMobileGrokWidth(width: number | null | undefined): boolean {
  if (typeof width !== "number" || !Number.isFinite(width)) return false
  return width < CODE_MOBILE_GROK_MAX_PX
}
