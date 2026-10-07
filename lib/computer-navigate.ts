/**
 * Client-side twin of backend/src/services/computer/navigate-url.js.
 * Keep the scheme rules in lockstep so the address bar refuses the same
 * URLs the API would reject.
 */

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|about|mailto|ftp|chrome|chrome-extension):/i
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
// "localhost:3000", "intranet:8080/app": a host with a port, not a scheme.
const HOST_PORT_RE = /^[a-z0-9.-]+:\d{1,5}(?=[/?#]|$)/i
const SINGLE_LABEL_RE = /^[a-z0-9_-]+$/i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
export const DEFAULT_SEARCH_URL = "https://www.google.com/search?q="
export const MAX_SEARCH_QUERY_CHARS = 180

export type NavigateUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

export const COMPUTER_NAVIGATE_WINDOW_EVENT = "siragpt:computer-navigate"

export type ComputerNavigateDetail = {
  url: string
  conversationId?: string | null
  tool?: string
}

export function parseNavigateUrlFromToolArgs(args: unknown): string | null {
  if (args == null) return null
  let record: Record<string, unknown> | null = null
  if (typeof args === "object" && !Array.isArray(args)) {
    record = args as Record<string, unknown>
  } else if (typeof args === "string") {
    const raw = args.trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>
    } catch {
      const direct = sanitizeNavigateUrl(raw)
      return direct.ok ? direct.url : null
    }
  }
  if (!record) return null
  const candidate = record.url || record.href || record.uri
  const parsed = sanitizeNavigateUrl(candidate)
  return parsed.ok ? parsed.url : null
}

export function isComputerNavigateTool(name: unknown): boolean {
  return /^(computer_navigate|browser_navigate)$/i.test(String(name || "").trim())
}

export function emitComputerNavigate(detail: ComputerNavigateDetail): void {
  if (typeof window === "undefined") return
  const url = String(detail?.url || "").trim()
  if (!url) return
  window.dispatchEvent(new CustomEvent<ComputerNavigateDetail>(COMPUTER_NAVIGATE_WINDOW_EVENT, {
    detail: { url, conversationId: detail.conversationId || null, tool: detail.tool },
  }))
}

export function extractHttpUrlFromText(text: unknown): string | null {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i)
  if (!match) return null
  const parsed = sanitizeNavigateUrl(match[0])
  return parsed.ok ? parsed.url : null
}

export const DEFAULT_BROWSER_HOME = "https://www.google.com/"

export function searchUrlFor(query: unknown): string {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_QUERY_CHARS)
  return `${DEFAULT_SEARCH_URL}${encodeURIComponent(q)}`
}

/** Open a pasted URL, otherwise search the prompt on Google in the live Chrome. */
export function browserUrlFromPrompt(text: unknown): string {
  const direct = extractHttpUrlFromText(text)
  if (direct) return direct
  const q = String(text || "").replace(/\s+/g, " ").trim()
  if (!q) return DEFAULT_BROWSER_HOME
  return searchUrlFor(q)
}

function hasScheme(value: string): boolean {
  return SCHEME_RE.test(value) && !HOST_PORT_RE.test(value)
}

/**
 * Text no DNS could resolve — a single dotless label («google») or words with
 * spaces («clima en lima») — is a search, like in any address bar. A scheme,
 * a dotted host, `localhost`, an IP literal or a port mean "this is an address".
 */
export function looksLikeSearchQuery(raw: unknown): boolean {
  const text = String(raw || "").trim()
  if (!text || hasScheme(text)) return false
  const authority = text.split(/[/?#]/)[0]
  if (!authority) return false
  if (/\s/.test(authority)) return true
  if (!SINGLE_LABEL_RE.test(authority)) return false
  if (authority.toLowerCase() === "localhost") return false
  if (IPV4_RE.test(authority)) return false
  return true
}

export function sanitizeNavigateUrl(raw: unknown): NavigateUrlResult {
  let value = String(raw || "").trim()
  if (!value) return { ok: false, error: "La URL debe ser http(s)." }
  if (BLOCKED_SCHEME.test(value)) return { ok: false, error: "La URL debe ser http(s)." }
  if (looksLikeSearchQuery(value)) return { ok: true, url: searchUrlFor(value) }
  if (!hasScheme(value)) value = `https://${value}`
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
