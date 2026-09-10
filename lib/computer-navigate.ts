/**
 * Client-side twin of backend/src/services/computer/navigate-url.js.
 * Keep the scheme rules in lockstep so the address bar refuses the same
 * URLs the API would reject.
 */

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|about|mailto|ftp|chrome|chrome-extension):/i

export type NavigateUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

export function sanitizeNavigateUrl(raw: unknown): NavigateUrlResult {
  let value = String(raw || "").trim()
  if (!value) return { ok: false, error: "La URL debe ser http(s)." }
  if (BLOCKED_SCHEME.test(value)) return { ok: false, error: "La URL debe ser http(s)." }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "La URL debe ser http(s)." }
    }
    if (!parsed.hostname) return { ok: false, error: "La URL debe ser http(s)." }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false, error: "La URL debe ser http(s)." }
  }
}
