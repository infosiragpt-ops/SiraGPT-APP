/**
 * Per-chat pinned image storage for /agentes.
 * Persists pinned images cleanly in localStorage scoped by chatId and emits a
 * lightweight window event so inline badges and the pinned-images bar stay in
 * sync without forcing extra chat message re-renders.
 */

export interface PinnedChatImage {
  id: string
  fileId?: string
  url: string
  name: string
  prompt?: string
  aspectRatio?: string
  messageId?: string
  chatId: string
  pinnedAt: number
}

const STORAGE_KEY = "siragpt:pinned-images:v1"
const MAX_PINNED_PER_CHAT = 12
export const PINNED_IMAGES_EVENT = "siragpt:pinned-images-changed"

type StoreShape = Record<string, PinnedChatImage[]>

function readStore(): StoreShape {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: StoreShape, chatId: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore storage quota errors cleanly
  }
  window.dispatchEvent(new CustomEvent(PINNED_IMAGES_EVENT, { detail: { chatId } }))
}

export function getPinnedImages(chatId?: string | null): PinnedChatImage[] {
  const key = String(chatId || "").trim()
  if (!key) return []
  const store = readStore()
  const list = store[key]
  return Array.isArray(list) ? list : []
}

export function isImagePinned(chatId?: string | null, imageId?: string | null): boolean {
  const target = String(imageId || "").trim()
  if (!chatId || !target) return false
  return getPinnedImages(chatId).some((item) => item.id === target || (item.fileId && item.fileId === target))
}

export function togglePinnedImage(
  chatId: string,
  item: Omit<PinnedChatImage, "chatId" | "pinnedAt">,
): { pinned: boolean; items: PinnedChatImage[] } {
  const key = String(chatId || "").trim()
  if (!key || !item.id) return { pinned: false, items: [] }
  const store = readStore()
  const current = Array.isArray(store[key]) ? store[key] : []
  const exists = current.some((entry) => entry.id === item.id || (item.fileId && entry.fileId === item.fileId))

  let next: PinnedChatImage[]
  if (exists) {
    next = current.filter((entry) => entry.id !== item.id && (!item.fileId || entry.fileId !== item.fileId))
  } else {
    next = [
      { ...item, chatId: key, pinnedAt: Date.now() },
      ...current,
    ].slice(0, MAX_PINNED_PER_CHAT)
  }

  if (next.length === 0) {
    delete store[key]
  } else {
    store[key] = next
  }
  writeStore(store, key)
  return { pinned: !exists, items: next }
}

export function removePinnedImage(chatId: string, imageId: string): PinnedChatImage[] {
  const key = String(chatId || "").trim()
  if (!key || !imageId) return []
  const store = readStore()
  const current = Array.isArray(store[key]) ? store[key] : []
  const next = current.filter((entry) => entry.id !== imageId && entry.fileId !== imageId)
  if (next.length === 0) delete store[key]
  else store[key] = next
  writeStore(store, key)
  return next
}
