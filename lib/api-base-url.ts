export const DEFAULT_API_BASE_URL = "http://localhost:5000/api"

const FORBIDDEN_API_HOST = /api\.siragpt\.com/i

function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || "").trim())
}

/** Backend mounts routes under `/api`; accept env values with or without that suffix. */
export function getNormalizedApiBaseUrl(raw = process.env.NEXT_PUBLIC_API_URL): string {
  const value = raw?.trim() || DEFAULT_API_BASE_URL
  if (/openrouter\.ai/i.test(value)) {
    throw new Error("NEXT_PUBLIC_API_URL must not point at openrouter.ai")
  }
  const trimmed = value.replace(/\/+$/, "")
  if (trimmed.endsWith("/api")) return trimmed
  return `${trimmed}/api`
}

/**
 * Browser computer-pane helper. Chat already hits same-origin /api on
 * siragpt.com; never follow NEXT_PUBLIC_API_URL to api.siragpt.com (404)
 * or localhost:5000 in production.
 */
export function getSameOriginApiBaseUrl(
  raw = process.env.NEXT_PUBLIC_API_URL,
  locationOrigin?: string,
): string {
  const origin = String(
    locationOrigin
    ?? (typeof window !== "undefined" ? window.location?.origin : "")
    ?? "",
  ).replace(/\/+$/, "")
  if (origin && !isLoopbackOrigin(origin)) {
    return `${origin}/api`
  }
  const normalized = getNormalizedApiBaseUrl(raw)
  if (FORBIDDEN_API_HOST.test(normalized)) return "/api"
  if (process.env.NODE_ENV === "production" && /localhost:5000/i.test(normalized)) {
    return "/api"
  }
  return normalized
}
