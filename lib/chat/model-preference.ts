/**
 * Per-user model preference for /agentes.
 *
 * - last pick: remembered for the next new chat
 * - pinned default: "Fijar modelo" — used when opening a new conversation
 *
 * Conversation-scoped choice lives on `chat.model`. This module only
 * stores the cross-chat default / last-used ids.
 */

export const PINNED_MODEL_STORAGE_KEY = "sira:chat:pinned-model"
export const LAST_MODEL_STORAGE_KEY = "sira:chat:last-model"

function readKey(key: string): string {
  if (typeof window === "undefined") return ""
  try {
    return String(window.localStorage.getItem(key) || "").trim()
  } catch {
    return ""
  }
}

function writeKey(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    const next = String(value || "").trim()
    if (!next) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, next)
  } catch {
    /* private mode */
  }
}

export function getPinnedModel(): string {
  return readKey(PINNED_MODEL_STORAGE_KEY)
}

export function setPinnedModel(modelName: string): void {
  writeKey(PINNED_MODEL_STORAGE_KEY, modelName)
}

export function clearPinnedModel(): void {
  writeKey(PINNED_MODEL_STORAGE_KEY, "")
}

export function getLastModel(): string {
  return readKey(LAST_MODEL_STORAGE_KEY)
}

export function setLastModel(modelName: string): void {
  writeKey(LAST_MODEL_STORAGE_KEY, modelName)
}

export function isPinnedModel(modelName: string, pinned = getPinnedModel()): boolean {
  const wanted = String(modelName || "").trim().toLowerCase()
  const current = String(pinned || "").trim().toLowerCase()
  return Boolean(wanted && current && wanted === current)
}
