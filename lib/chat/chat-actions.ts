/**
 * Chat-level actions shared by the /agentes header title menu and the
 * sidebar (claude.ai style: Programar · Convertir en habilidad · Copiar ID ·
 * Fijar · Cambiar nombre · Añadir al proyecto · Archivar · Eliminar).
 *
 * The sidebar owns the folder/archive/schedule state (localStorage +
 * account sync), so the header asks it to act through a window event
 * instead of duplicating that logic. Navigation requests work the same
 * way: the sidebar holds the app router.
 */

import {
  CHAT_FOLDERS_STORAGE_KEY,
  CHAT_FOLDER_NAMES_STORAGE_KEY,
  SUGGESTED_CHAT_FOLDERS,
  listChatFolderNames,
  parseChatFolderAssignments,
  parseChatFolderNameList,
} from "@/lib/sidebar-chat-folders"

export const CHAT_ACTION_EVENT = "sira:chat-action"
export const NAVIGATE_EVENT = "sira:navigate"
export const COMPOSER_PREFILL_EVENT = "sira:composer-prefill"
const COMPOSER_PREFILL_KEY = "sira:composer-prefill"
const PREFILL_TTL_MS = 5 * 60 * 1000

export type ChatActionKind = "schedule" | "archive" | "folder"

export type ChatActionDetail = {
  action: ChatActionKind
  chatId: string
  title?: string | null
  /** `folder`: destination name, or null to take the chat out of its folder. */
  folder?: string | null
}

/** Ask the sidebar (owner of folders/archive/schedule) to run an action. */
export function requestChatAction(detail: ChatActionDetail): boolean {
  if (typeof window === "undefined" || !detail?.chatId) return false
  window.dispatchEvent(new CustomEvent<ChatActionDetail>(CHAT_ACTION_EVENT, { detail }))
  return true
}

/** SPA navigation without mounting a router in every component. */
export function requestNavigation(href: string): void {
  if (typeof window === "undefined" || !href) return
  const event = new CustomEvent<{ href: string }>(NAVIGATE_EVENT, { detail: { href }, cancelable: true })
  const handled = !window.dispatchEvent(event)
  // No sidebar mounted (public pages): fall back to a full navigation.
  if (!handled) window.location.assign(href)
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Folder names the user can send a chat to, plus the chat's current one. */
export function readChatFolders(chatId?: string | null): { folders: string[]; current: string | null } {
  if (typeof window === "undefined") return { folders: [...SUGGESTED_CHAT_FOLDERS], current: null }
  const assignments = parseChatFolderAssignments(readJson(CHAT_FOLDERS_STORAGE_KEY))
  const named = parseChatFolderNameList(readJson(CHAT_FOLDER_NAMES_STORAGE_KEY))
  const folders = listChatFolderNames(assignments, [...SUGGESTED_CHAT_FOLDERS, ...named])
  return { folders, current: (chatId && assignments[chatId]) || null }
}

/**
 * Text the composer should start with on the next new chat («Convertir en
 * habilidad» opens a fresh chat with skill-creator and this brief).
 */
export function setComposerPrefill(text: string): void {
  if (typeof window === "undefined") return
  const value = String(text || "").trim()
  if (!value) return
  try {
    window.sessionStorage.setItem(COMPOSER_PREFILL_KEY, JSON.stringify({ text: value, at: Date.now() }))
  } catch {
    /* private mode: the live event below still delivers it */
  }
  window.dispatchEvent(new CustomEvent<{ text: string }>(COMPOSER_PREFILL_EVENT, { detail: { text: value } }))
}

export function consumeComposerPrefill(): string | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(COMPOSER_PREFILL_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(COMPOSER_PREFILL_KEY)
    const parsed = JSON.parse(raw) as { text?: string; at?: number }
    if (!parsed?.text || typeof parsed.at !== "number" || Date.now() - parsed.at > PREFILL_TTL_MS) return null
    return parsed.text
  } catch {
    return null
  }
}

/** Brief handed to skill-creator when a chat is turned into a skill. */
export function skillFromChatPrompt(title: string, chatId: string): string {
  const name = (title || "").trim() || "este chat"
  return [
    `Convierte la conversación «${name}» (ID de sesión ${chatId}) en una habilidad reutilizable.`,
    "Recupera esa conversación, resume el procedimiento que seguimos, los criterios de calidad y el formato de salida,",
    "propón un nombre corto y una descripción, y cuando la confirme guárdala con save_skill.",
  ].join(" ")
}
