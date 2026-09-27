"use client"

import * as React from "react"
import { apiClient } from "@/lib/api"

/**
 * Pinned chats live in two places: the backend (`PATCH /chats/:id/pin`) and
 * an optimistic localStorage set so the sidebar reflects the change even
 * when the API is down. Both the sidebar menu and the /agentes header menu
 * mutate the same set through this module; every write broadcasts
 * `siragpt:pinned-chats-changed` so each consumer re-reads the storage.
 */
export const PINNED_CHATS_STORAGE_KEY = "sira:pinned-chat-ids"
export const PINNED_CHATS_CHANGED_EVENT = "siragpt:pinned-chats-changed"

export function readPinnedChatIds(): string[] {
  if (typeof window === "undefined") return []
  try {
    const value = JSON.parse(window.localStorage.getItem(PINNED_CHATS_STORAGE_KEY) || "[]")
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

export type PinnedChatsChangedDetail = { chatId: string; pinned: boolean } | undefined

export function writePinnedChatIds(ids: string[], detail?: PinnedChatsChangedDetail): string[] {
  const next = Array.from(new Set(ids))
  if (typeof window === "undefined") return next
  try {
    window.localStorage.setItem(PINNED_CHATS_STORAGE_KEY, JSON.stringify(next))
  } catch (err) {
    console.debug("storage unavailable", err)
  }
  window.dispatchEvent(new CustomEvent<PinnedChatsChangedDetail>(PINNED_CHATS_CHANGED_EVENT, { detail }))
  return next
}

export function isChatIdPinned(chatId: string | null | undefined, ids: string[] = readPinnedChatIds()): boolean {
  return Boolean(chatId) && ids.includes(chatId as string)
}

/**
 * Optimistically pins/unpins locally, then syncs with the backend. Resolves
 * `synced: false` when the API call failed (the local state is kept so the
 * caller can warn without reverting the UI).
 */
export async function setChatPinned(chatId: string, pinned: boolean): Promise<{ pinned: boolean; synced: boolean }> {
  const rest = readPinnedChatIds().filter((id) => id !== chatId)
  writePinnedChatIds(pinned ? [chatId, ...rest] : rest, { chatId, pinned })
  try {
    await apiClient.pinChat(chatId, pinned)
    return { pinned, synced: true }
  } catch {
    return { pinned, synced: false }
  }
}

export function removePinnedChatId(chatId: string): void {
  const ids = readPinnedChatIds()
  if (!ids.includes(chatId)) return
  writePinnedChatIds(ids.filter((id) => id !== chatId), { chatId, pinned: false })
}

/** Subscribes to the localStorage set; re-renders on every write from any surface. */
export function usePinnedChats(): string[] {
  const [ids, setIds] = React.useState<string[]>([])
  React.useEffect(() => {
    const sync = () => setIds(readPinnedChatIds())
    sync()
    window.addEventListener(PINNED_CHATS_CHANGED_EVENT, sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener(PINNED_CHATS_CHANGED_EVENT, sync)
      window.removeEventListener("storage", sync)
    }
  }, [])
  return ids
}
