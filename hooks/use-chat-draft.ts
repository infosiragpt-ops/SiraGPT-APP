"use client"

import * as React from "react"

const STORAGE_PREFIX = "sira:chat-draft:"
const SAVE_DEBOUNCE_MS = 350
const MAX_DRAFT_CHARS = 64 * 1024

function storageKey(
  userId: string | null | undefined,
  chatId: string | null | undefined,
): string | null {
  if (!userId || typeof userId !== "string") return null
  if (!chatId || typeof chatId !== "string") return null
  return `${STORAGE_PREFIX}${userId}:${chatId}`
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — silent */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* harmless */
  }
}

/**
 * Wipe every saved composer draft from localStorage. Call this from
 * the sign-out flow so a different account on the same device cannot
 * see the previous user's in-progress chat text.
 */
export function clearAllChatDrafts(): void {
  if (typeof window === "undefined") return
  try {
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k)
    }
    for (const k of toRemove) safeRemove(k)
  } catch {
    /* enumeration blocked — best-effort only */
  }
}

export interface ChatDraftApi {
  loadInitial: () => string | null
  save: (value: string) => void
  clear: () => void
}

/**
 * useChatDraft — debounced, per-(user, chat) draft persistence for the
 * composer.
 *
 * Drafts are scoped to BOTH the signed-in userId AND the chatId so:
 *   - Each conversation keeps its own in-progress text across reloads.
 *   - A different account on a shared device cannot see another user's
 *     unsent message (the key namespace doesn't overlap, and
 *     `clearAllChatDrafts()` should also be called on sign-out as a
 *     belt-and-suspenders cleanup).
 *
 * The "new chat" surface (no chatId yet) intentionally does NOT
 * persist — the draft can't be unambiguously re-attached to a specific
 * future conversation.
 *
 * Race-safety contract:
 *   - The storage key is snapshotted at `save()` time, not at flush
 *     time. If the user types in chat A and switches to chat B before
 *     the 350ms debounce flushes, A's text still lands under A's key.
 *   - Multiple pending writes for different keys all flush; pending
 *     writes for the same key are coalesced (last write wins).
 *
 * Failure modes (private browsing, quota, disabled storage) are
 * swallowed silently — the composer must keep working either way.
 */
export function useChatDraft(
  chatId: string | null | undefined,
  userId: string | null | undefined,
): ChatDraftApi {
  const keyRef = React.useRef<string | null>(storageKey(userId, chatId))
  React.useEffect(() => {
    keyRef.current = storageKey(userId, chatId)
  }, [userId, chatId])

  // Map<storageKey, latestPendingValue>. Snapshotting the key at save
  // time means a chat-switch during the debounce window cannot misroute
  // the previous chat's text to the new chat's key.
  const pendingByKeyRef = React.useRef<Map<string, string>>(new Map())
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = React.useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const pending = pendingByKeyRef.current
    if (pending.size === 0) return
    pendingByKeyRef.current = new Map()
    for (const [key, value] of pending) {
      if (value.length === 0) {
        safeRemove(key)
      } else {
        safeSet(key, value.slice(0, MAX_DRAFT_CHARS))
      }
    }
  }, [])

  const save = React.useCallback((value: string) => {
    if (typeof window === "undefined") return
    const key = keyRef.current
    if (!key) return
    pendingByKeyRef.current.set(key, value)
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  const clear = React.useCallback(() => {
    if (typeof window === "undefined") return
    const key = keyRef.current
    if (!key) return
    // Drop any pending write for this key so it doesn't race the clear,
    // but leave pending writes for OTHER keys (e.g. a different chat the
    // user already switched into) intact.
    pendingByKeyRef.current.delete(key)
    safeRemove(key)
  }, [])

  const loadInitial = React.useCallback((): string | null => {
    if (typeof window === "undefined") return null
    const key = keyRef.current
    if (!key) return null
    return safeGet(key)
  }, [])

  // Flush pending writes on tab hide / unload so unsaved keystrokes
  // survive the inevitable race with `beforeunload`.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onHide = () => flush()
    window.addEventListener("beforeunload", onHide)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("beforeunload", onHide)
      document.removeEventListener("visibilitychange", onHide)
      flush()
    }
  }, [flush])

  return { loadInitial, save, clear }
}
