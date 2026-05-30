/**
 * PendingMessages — Persist outgoing messages to localStorage and auto-retry.
 *
 * WHY:
 *   If the network drops mid-send, the message is lost and the user has to
 *   re-type everything. This utility saves the send payload before the first
 *   attempt and clears it only after the server confirms delivery.
 *
 * HOW IT WORKS:
 *   1. `save(content, files, chatId, intent?)` stores the draft in localStorage
 *   2. `clear(chatId)` removes the draft on success
 *   3. `getAll()` loads all pending messages (for init check)
 *   4. Auto-retry via `retryAll(sendFn)` when network comes back
 */

const STORAGE_KEY = 'sira_pending_messages'

export interface PendingMessage {
  /** Unique id so we don't double-send if the page reloads */
  id: string
  content: string
  chatId: string
  fileIds?: string[]
  intentOverride?: string
  /** ISO timestamp of first attempt */
  createdAt: string
  /** How many times we've tried */
  attempts: number
  /** Max attempts before giving up */
  maxAttempts: number
  /** ISO timestamp of the last retry attempt */
  lastAttemptAt?: string
  /** ISO timestamp before which retryAll should skip this item */
  nextRetryAt?: string
  /** Last transport error, useful for diagnostics/support */
  lastError?: string
}

let retryInFlight: Promise<{ retried: number; stillPending: number }> | null = null

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

function getAllRaw(): PendingMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function persistAll(items: PendingMessage[]): void {
  if (typeof window === 'undefined') return
  try {
    if (items.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    }
  } catch {
    // localStorage full — drop quietly
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function save(
  content: string,
  chatId: string,
  fileIds?: string[],
  intentOverride?: string,
): PendingMessage {
  const item: PendingMessage = {
    id: `${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content,
    chatId,
    fileIds,
    intentOverride,
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 5,
  }
  const all = getAllRaw()
  // Replace any previous pending message for the same chat (only one
  // pending message per chat makes sense — it's the last unsent one).
  const filtered = all.filter((m) => m.chatId !== chatId)
  persistAll([...filtered, item])
  return item
}

export function clear(chatId: string): void {
  const all = getAllRaw()
  const filtered = all.filter((m) => m.chatId !== chatId)
  persistAll(filtered)
}

export function getForChat(chatId: string): PendingMessage | undefined {
  return getAllRaw().find((m) => m.chatId === chatId)
}

export function getAll(): PendingMessage[] {
  return getAllRaw()
}

export function count(): number {
  return getAllRaw().length
}

/**
 * Retry all pending messages in sequence using the supplied send
 * function.  Returns the number of messages that were still pending
 * (i.e. not successfully retried) so callers can decide what to show.
 */
export async function retryAll(
  sendFn: (msg: PendingMessage) => Promise<boolean>,
): Promise<{ retried: number; stillPending: number }> {
  if (retryInFlight) return retryInFlight

  retryInFlight = retryAllInternal(sendFn).finally(() => {
    retryInFlight = null
  })
  return retryInFlight
}

async function retryAllInternal(
  sendFn: (msg: PendingMessage) => Promise<boolean>,
): Promise<{ retried: number; stillPending: number }> {
  const items = getAllRaw()
  if (items.length === 0) return { retried: 0, stillPending: 0 }

  let retried = 0
  let stillPending = 0
  const now = Date.now()

  for (const item of items) {
    if (item.attempts >= item.maxAttempts) {
      stillPending++
      continue
    }
    if (item.nextRetryAt && Date.parse(item.nextRetryAt) > now) {
      stillPending++
      continue
    }
    item.attempts++
    item.lastAttemptAt = new Date().toISOString()
    item.nextRetryAt = undefined
    item.lastError = undefined

    try {
      const ok = await sendFn(item)
      if (ok) {
        // Remove from storage on success
        const all = getAllRaw()
        persistAll(all.filter((m) => m.id !== item.id))
        retried++
      } else {
        const all = getAllRaw()
        const updated = all.map((m) => (m.id === item.id ? withRetryDelay(item) : m))
        persistAll(updated)
        stillPending++
      }
    } catch (error) {
      // Failed this attempt — keep in storage for next retry
      // Update attempt count
      const all = getAllRaw()
      item.lastError = error instanceof Error ? error.message : "send_failed"
      const updated = all.map((m) => (m.id === item.id ? withRetryDelay(item) : m))
      persistAll(updated)
      stillPending++
    }
  }

  return { retried, stillPending }
}

/**
 * Subscribe to online/offline events to auto-retry.
 * Returns an unsubscribe function.
 */
export function subscribeOnlineRetry(
  sendFn: (msg: PendingMessage) => Promise<boolean>,
): () => void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return () => {}

  const handler = () => {
    if (navigator.onLine) {
      retryAll(sendFn)
    }
  }
  window.addEventListener('online', handler)
  // Also try immediately if we're already online
  if (navigator.onLine) {
    // Defer to let the app settle
    setTimeout(handler, 1000)
  }
  return () => window.removeEventListener('online', handler)
}

function withRetryDelay(item: PendingMessage): PendingMessage {
  const nextAttempt = Math.max(1, item.attempts)
  const delayMs = Math.min(30_000, 1_000 * 2 ** (nextAttempt - 1))
  return {
    ...item,
    nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
  }
}
