/**
 * Persistent app pins — composer rail + Apps panel (spec "apps-persistent-pins").
 *
 * Pure helpers: catalog search (normalize + rank), pin guards (≤4,
 * connected-only, available-only), chip state derivation and draft
 * persistence keys. No React, no network — unit-testable.
 */

export const MAX_PINS = 4

export const PIN_STORAGE_PREFIX = "apps.pins.draft."

export type ChipStatus = "active" | "loading" | "warning" | "blocked"

export type PinValidationError =
  | "APP_NOT_CONNECTED"
  | "APP_UNAVAILABLE"
  | "PIN_LIMIT"
  | "APP_NOT_FOUND"

export interface PinnedChipInput {
  appId: string
  availability?: string
  connectionStatus?: string | null
  connecting?: boolean
  expiresAt?: string | null
  lastError?: string | null
}

export function normalizeSearch(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export interface SearchableApp {
  id: string
  handle?: string
  name: string
  aliases?: string[]
  description?: string
  category?: string
}

/**
 * Rank a catalog app against a query (0 = no match). Exact handle/id match
 * wins, then prefix matches on name/aliases, then substring matches.
 */
export function rankApp(app: SearchableApp, query: string): number {
  const q = normalizeSearch(query)
  if (!q) return 0
  const name = normalizeSearch(app.name)
  const id = normalizeSearch(app.id)
  const handle = normalizeSearch(app.handle || `@${app.name}`)
  if (handle === q || handle === `@${q}` || id === q) return 100
  if (name.startsWith(q)) return 80
  if ((app.aliases || []).some((alias) => normalizeSearch(alias).startsWith(q))) return 70
  if (name.includes(q)) return 50
  if (normalizeSearch(app.description || "").includes(q)) return 20
  if (normalizeSearch(app.category || "").includes(q)) return 15
  return -1
}

export function filterAndRankApps<T extends SearchableApp>(apps: T[], query: string): T[] {
  const q = normalizeSearch(query)
  return apps
    .map((app) => ({ app, rank: rankApp(app, q) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.app)
}

/** Connection is active when the backend says connected (never client-inferred). */
export function isPinConnected(status: string | null | undefined): boolean {
  return String(status || "").trim() === "connected"
}

/** Guard: only available + connected apps can be pinned. */
export function canPinApp(app: PinnedChipInput): boolean {
  if (app.availability === "unavailable") return false
  if (app.connecting) return false
  return isPinConnected(app.connectionStatus)
}

/** Guard: the rail holds at most MAX_PINS apps. */
export function canAddPin(currentPins: string[]): boolean {
  return Array.isArray(currentPins) && currentPins.length < MAX_PINS
}

/**
 * Derive the chip state (spec §2). `active` = usable right now;
 * `warning` = connected but expiring soon or a non-fatal error;
 * `blocked` = expired/revoked/error/unavailable — shown once so the user
 * understands, then dismissed by closing the chip.
 */
export function deriveChipStatus(input: PinnedChipInput): ChipStatus {
  if (input.availability === "unavailable") return "blocked"
  if (input.connecting) return "loading"
  const status = String(input.connectionStatus || "").trim()
  if (status === "expired" || status === "revoked" || status === "error") return "blocked"
  if (status !== "connected") return "blocked"
  if (input.expiresAt) {
    const exp = new Date(input.expiresAt).getTime()
    if (Number.isFinite(exp) && exp - Date.now() < 24 * 60 * 60 * 1000) return "warning"
  }
  if (input.lastError) return "warning"
  return "active"
}

/** Draft pins survive a refresh before the first message is sent. */
export function readDraftPins(draftId: string): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(`${PIN_STORAGE_PREFIX}${draftId}`)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.map(String).slice(0, MAX_PINS) : []
  } catch {
    return []
  }
}

export function writeDraftPins(draftId: string, pins: string[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      `${PIN_STORAGE_PREFIX}${draftId}`,
      JSON.stringify(pins.slice(0, MAX_PINS)),
    )
  } catch {
    /* private mode */
  }
}

export function clearDraftPins(draftId: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(`${PIN_STORAGE_PREFIX}${draftId}`)
  } catch {
    /* private mode */
  }
}

/** Toggle without duplicates; enforces the max. Returns the new list or null when blocked. */
export function togglePin(current: string[], appId: string): { pins: string[]; added: boolean } | null {
  const next = Array.isArray(current) ? current.filter(Boolean) : []
  if (next.includes(appId)) {
    return { pins: next.filter((id) => id !== appId), added: false }
  }
  if (next.length >= MAX_PINS) return null
  return { pins: [...next, appId], added: true }
}
