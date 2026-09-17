/**
 * Client-side twin of backend/src/services/computer/navigate-url.js.
 * Keep the scheme rules in lockstep so the address bar refuses the same
 * URLs the API would reject.
 */

const BLOCKED_SCHEME = /^(javascript|data|file|vbscript|blob|about|mailto|ftp|chrome|chrome-extension):/i

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

/** Open a pasted URL, otherwise search the prompt on Google in the live Chrome. */
export function browserUrlFromPrompt(text: unknown): string {
  const direct = extractHttpUrlFromText(text)
  if (direct) return direct
  const q = String(text || "").replace(/\s+/g, " ").trim().slice(0, 180)
  if (!q) return DEFAULT_BROWSER_HOME
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}

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
