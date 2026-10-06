/**
 * Sidebar «··· Más» → Video / Voz / Imagen / Música: start a fresh chat with
 * that media mode already selected in the composer.
 *
 * The request is stored for the next composer mount (navigating from
 * /library, /gpts… mounts the chat after the click) and also announced live
 * for a composer that is already open. Whoever handles it first consumes it,
 * so the mode is applied exactly once.
 */

import type { MediaMode } from "./media-mode-chips"

export const MEDIA_MODE_LAUNCH_EVENT = "sira:media-mode-launch"
const MEDIA_MODE_LAUNCH_KEY = "sira:media-mode-launch"
const MEDIA_MODE_LAUNCH_TTL_MS = 60 * 1000

export const MEDIA_LAUNCH_MODES: readonly MediaMode[] = Object.freeze(["video", "voice", "image", "music"])

export const MEDIA_LAUNCH_LABELS: Readonly<Record<MediaMode, string>> = Object.freeze({
  video: "Video",
  voice: "Voz",
  image: "Imagen",
  music: "Música",
})

export function isMediaMode(value: unknown): value is MediaMode {
  return typeof value === "string" && (MEDIA_LAUNCH_MODES as readonly string[]).includes(value)
}

/** Store the launch for the next composer mount (survives navigation). */
export function storeMediaModeLaunch(mode: MediaMode, now = Date.now()) {
  if (typeof window === "undefined" || !isMediaMode(mode)) return
  try {
    window.sessionStorage.setItem(MEDIA_MODE_LAUNCH_KEY, JSON.stringify({ mode, at: now }))
  } catch {
    /* private mode: the live event still reaches an open composer */
  }
}

/** Tell an already-open composer to pick the stored launch up now. */
export function announceMediaModeLaunch(mode: MediaMode) {
  if (typeof window === "undefined" || !isMediaMode(mode)) return
  window.dispatchEvent(new CustomEvent<MediaMode>(MEDIA_MODE_LAUNCH_EVENT, { detail: mode }))
}

/** Read and clear a pending launch (null when none, stale or malformed). */
export function consumeMediaModeLaunch(now = Date.now()): MediaMode | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(MEDIA_MODE_LAUNCH_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(MEDIA_MODE_LAUNCH_KEY)
    const parsed = JSON.parse(raw) as { mode?: unknown; at?: unknown }
    if (!isMediaMode(parsed?.mode) || typeof parsed.at !== "number") return null
    if (now - parsed.at > MEDIA_MODE_LAUNCH_TTL_MS || parsed.at > now + 1000) return null
    return parsed.mode
  } catch {
    return null
  }
}
