/**
 * Per-user model preference for /agentes.
 *
 * - last pick: remembered for the next new chat
 * - pinned default: "Fijar modelo" — used when opening a new conversation
 *
 * Conversation-scoped choice lives on `chat.model`. This module only
 * stores the cross-chat default / last-used ids.
 *
 * Video/image/audio ids (Seedance, etc.) must never persist here: after
 * #479 they survived as leftover picker state once they left the TEXT catalog.
 */

import { isNonChatMediaModel } from "./chat-model-guard"

export const PINNED_MODEL_STORAGE_KEY = "sira:chat:pinned-model"
export const LAST_MODEL_STORAGE_KEY = "sira:chat:last-model"

function chatOnly(modelName: string): string {
  const next = String(modelName || "").trim()
  if (!next || isNonChatMediaModel(next)) return ""
  return next
}

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
  return chatOnly(readKey(PINNED_MODEL_STORAGE_KEY))
}

export function setPinnedModel(modelName: string): void {
  writeKey(PINNED_MODEL_STORAGE_KEY, chatOnly(modelName))
}

export function clearPinnedModel(): void {
  writeKey(PINNED_MODEL_STORAGE_KEY, "")
}

export function getLastModel(): string {
  return chatOnly(readKey(LAST_MODEL_STORAGE_KEY))
}

export function setLastModel(modelName: string): void {
  writeKey(LAST_MODEL_STORAGE_KEY, chatOnly(modelName))
}

export function isPinnedModel(modelName: string, pinned = getPinnedModel()): boolean {
  const wanted = String(modelName || "").trim().toLowerCase()
  const current = String(pinned || "").trim().toLowerCase()
  return Boolean(wanted && current && wanted === current)
}
