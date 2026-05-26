export const DEFAULT_API_BASE_URL = "http://localhost:5000/api"

/** Backend mounts routes under `/api`; accept env values with or without that suffix. */
export function getNormalizedApiBaseUrl(raw = process.env.NEXT_PUBLIC_API_URL): string {
  const value = raw?.trim() || DEFAULT_API_BASE_URL
  const trimmed = value.replace(/\/+$/, "")
  if (trimmed.endsWith("/api")) return trimmed
  return `${trimmed}/api`
}
