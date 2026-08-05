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

export type PendingRetryResult = 'success' | 'failure' | 'defer'

export interface PendingRetryOptions {
  ownerId?: string
}

export interface PendingAIRequestEnvelope {
  provider: string
  model: string
  reasoningEffort?: string
  regenerate?: boolean
  regenerationAttempt?: number
  disableAgentic?: boolean
  enableWebGrounding?: boolean
  webGroundingQuery?: string
  webSearchMode?: string
}

export interface PendingGeneratePayload extends PendingAIRequestEnvelope {
  prompt: string
  chatId: string
  files?: string[]
  streamId: string
  idempotencyKey: string
}

export interface PendingMessage {
  /** Unique id so we don't double-send if the page reloads */
  id: string
  /** Stable backend turn identity, reused by every retry after reload */
  idempotencyKey: string
  /** Legacy/alternate persisted field accepted during migration */
  turnKey?: string
  /** Legacy transport identity, used only when no idempotency key was stored. */
  streamId?: string
  content: string
  chatId: string
  /** Account that created the draft; prevents cross-login replay. */
  ownerId?: string
  fileIds?: string[]
  intentOverride?: string
  /**
   * Only the ordinary /ai/generate text turn is safe to replay
   * automatically. Artifact/document/media operations remain manual because
   * their provider calls do not share this turn's idempotency contract.
   */
  retryPolicy?: 'automatic' | 'manual'
  /** Exact client request settings used by the first /ai/generate attempt. */
  requestEnvelope?: PendingAIRequestEnvelope
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

const retryInFlightByOwner = new Map<string, Promise<{ retried: number; stillPending: number }>>()

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

function getAllRaw(): PendingMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => ({
      ...item,
      // Drafts written before stable turn keys shipped use their immutable
      // pending id. This makes a reload retry the original backend turn.
      idempotencyKey: normalizeIdempotencyKey(item?.idempotencyKey || item?.turnKey)
        || String(item?.id || ''),
    }))
  } catch {
    return []
  }
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) return null
  return normalized
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
  idempotencyKey?: string,
  requestEnvelope?: PendingAIRequestEnvelope,
  ownerId?: string,
  streamId?: string,
): PendingMessage {
  const id = `${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const item: PendingMessage = {
    id,
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey) || id,
    content,
    chatId,
    ownerId: typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : undefined,
    streamId: normalizeIdempotencyKey(streamId) || undefined,
    fileIds,
    intentOverride,
    retryPolicy: 'manual',
    requestEnvelope,
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 5,
  }
  const all = getAllRaw()
  // Replace only the same logical turn. Two tabs can legitimately own
  // different keys in one chat; clearing/replacing K1 must never delete K2.
  const filtered = all.filter((message) => !(
    message.chatId === chatId
      && message.idempotencyKey === item.idempotencyKey
      && message.ownerId === item.ownerId
  ))
  persistAll([...filtered, item])
  return item
}

/**
 * Mark a pending draft as safe for automatic replay immediately before its
 * first idempotent /ai/generate request. The identity guard prevents a late
 * update from mutating a newer draft for the same chat.
 */
export function enableAutomaticRetry(
  chatId: string,
  idempotencyKey: string,
  intentOverride: string,
  requestEnvelope: PendingAIRequestEnvelope,
  ownerId?: string,
): PendingMessage | undefined {
  const normalizedOwner = ownerId?.trim() || null
  let updatedItem: PendingMessage | undefined
  const updated = getAllRaw().map((item) => {
    if (
      item.chatId !== chatId
      || item.idempotencyKey !== idempotencyKey
      || (normalizedOwner && item.ownerId !== normalizedOwner)
    ) return item
    updatedItem = {
      ...item,
      intentOverride,
      retryPolicy: 'automatic',
      requestEnvelope: { ...requestEnvelope },
    }
    return updatedItem
  })
  if (updatedItem) persistAll(updated)
  return updatedItem
}

/** Build the exact replayable /ai/generate body from durable turn state. */
export function buildPendingGeneratePayload(options: {
  pending?: Pick<PendingMessage, 'requestEnvelope'> | null
  fallbackEnvelope: PendingAIRequestEnvelope
  prompt: string
  chatId: string
  files?: string[]
  streamId: string
  idempotencyKey: string
}): PendingGeneratePayload {
  const envelope = options.pending?.requestEnvelope || options.fallbackEnvelope
  return {
    ...envelope,
    prompt: options.prompt,
    chatId: options.chatId,
    files: options.files,
    streamId: options.streamId,
    idempotencyKey: options.idempotencyKey,
  }
}

/**
 * Locate a persisted USER/ASSISTANT pair by explicit turn metadata. Message
 * content is never an identity: users may legitimately send "sí" repeatedly.
 */
export function findPendingTurnMatch(
  messages: Array<{ role?: unknown; content?: unknown; metadata?: unknown }> | null | undefined,
  pending: Pick<PendingMessage, 'idempotencyKey' | 'turnKey' | 'streamId'>,
): { userIndex: number; assistantIndex: number; hasAssistantReply: boolean } {
  if (!Array.isArray(messages)) {
    return { userIndex: -1, assistantIndex: -1, hasAssistantReply: false }
  }

  const idempotencyKey = normalizeIdempotencyKey(pending.idempotencyKey)
  const legacyStreamId = normalizeIdempotencyKey(pending.streamId || pending.turnKey)
  const matchesIdentity = (message: { metadata?: unknown }) => {
    const metadata = parseMetadata(message.metadata)
    const storedIdempotencyKey = normalizeIdempotencyKey(metadata.idempotencyKey)
    if (idempotencyKey && storedIdempotencyKey === idempotencyKey) return true
    if (!legacyStreamId) return false
    return normalizeIdempotencyKey(metadata.streamId) === legacyStreamId
      || storedIdempotencyKey === legacyStreamId
  }

  const userIndex = messages.findIndex((message) => (
    String(message?.role || '').toUpperCase() === 'USER' && matchesIdentity(message)
  ))
  if (userIndex === -1) return { userIndex, assistantIndex: -1, hasAssistantReply: false }

  const relativeAssistantIndex = messages.slice(userIndex + 1).findIndex((message) => (
    String(message?.role || '').toUpperCase() === 'ASSISTANT' && matchesIdentity(message)
  ))
  const assistantIndex = relativeAssistantIndex === -1
    ? -1
    : userIndex + 1 + relativeAssistantIndex
  const assistantContent = assistantIndex === -1 ? null : messages[assistantIndex]?.content
  return {
    userIndex,
    assistantIndex,
    hasAssistantReply: typeof assistantContent === 'string' && assistantContent.trim().length > 0,
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function clear(chatId: string): void {
  const all = getAllRaw()
  const filtered = all.filter((m) => m.chatId !== chatId)
  persistAll(filtered)
}

export function clearTurn(chatId: string, idempotencyKey: string, ownerId?: string): void {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) return
  const normalizedOwner = ownerId?.trim() || null
  const filtered = getAllRaw().filter((message) => !(
    message.chatId === chatId
      && message.idempotencyKey === normalizedKey
      && (!normalizedOwner || message.ownerId === normalizedOwner)
  ))
  persistAll(filtered)
}

export function getForChat(chatId: string): PendingMessage | undefined {
  const matches = getAllRaw().filter((message) => message.chatId === chatId)
  return matches[matches.length - 1]
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
  sendFn: (msg: PendingMessage) => Promise<PendingRetryResult | boolean>,
  options: PendingRetryOptions = {},
): Promise<{ retried: number; stillPending: number }> {
  const retryScope = options.ownerId?.trim() || '__unscoped__'
  const existing = retryInFlightByOwner.get(retryScope)
  if (existing) return existing

  let retryPromise: Promise<{ retried: number; stillPending: number }>
  retryPromise = retryAllInternal(sendFn, options).finally(() => {
    if (retryInFlightByOwner.get(retryScope) === retryPromise) {
      retryInFlightByOwner.delete(retryScope)
    }
  })
  retryInFlightByOwner.set(retryScope, retryPromise)
  return retryPromise
}

async function retryAllInternal(
  sendFn: (msg: PendingMessage) => Promise<PendingRetryResult | boolean>,
  options: PendingRetryOptions,
): Promise<{ retried: number; stillPending: number }> {
  const items = getAllRaw()
  if (items.length === 0) return { retried: 0, stillPending: 0 }

  let retried = 0
  let stillPending = 0
  const now = Date.now()
  const ownerId = options.ownerId?.trim() || null

  for (const item of items) {
    if (ownerId && item.ownerId !== ownerId) {
      stillPending++
      continue
    }
    if (item.attempts >= item.maxAttempts) {
      stillPending++
      continue
    }
    if (item.nextRetryAt && Date.parse(item.nextRetryAt) > now) {
      stillPending++
      continue
    }
    try {
      const result = await sendFn(item)
      const disposition: PendingRetryResult = result === true
        ? 'success'
        : result === false
          ? 'failure'
          : result
      if (disposition === 'success') {
        // Remove from storage on success
        const all = getAllRaw()
        persistAll(all.filter((m) => m.id !== item.id))
        retried++
      } else if (disposition === 'defer') {
        // The original stream may still own this turn, or this draft belongs
        // to a non-idempotent operation. Deferral is not a failed attempt:
        // preserve attempts/backoff byte-for-byte for a later terminal replay
        // or explicit user action.
        stillPending++
      } else {
        const failedItem = markRetryFailure(item)
        const all = getAllRaw()
        const updated = all.map((m) => (m.id === item.id ? withRetryDelay(failedItem) : m))
        persistAll(updated)
        stillPending++
      }
    } catch (error) {
      // Failed this attempt — keep in storage for next retry
      // Update attempt count
      const all = getAllRaw()
      const failedItem = markRetryFailure(
        item,
        error instanceof Error ? error.message : 'send_failed',
      )
      const updated = all.map((m) => (m.id === item.id ? withRetryDelay(failedItem) : m))
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
  sendFn: (msg: PendingMessage) => Promise<PendingRetryResult | boolean>,
  options: PendingRetryOptions = {},
): () => void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return () => {}

  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const armNextBackoff = () => {
    if (disposed || !navigator.onLine) return
    const now = Date.now()
    const boundedRecheckMs = 5_000
    const ownerId = options.ownerId?.trim() || null
    const nextAt = getAllRaw()
      .filter((item) => (
        item.retryPolicy === 'automatic'
          && (!ownerId || item.ownerId === ownerId)
          && item.attempts < item.maxAttempts
      ))
      .map((item) => item.nextRetryAt ? Date.parse(item.nextRetryAt) : Number.NaN)
      // An expired backoff was already considered by the current retry pass.
      // Re-arming it at 0ms would create a tight loop when the callback defers.
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
      .sort((a, b) => a - b)[0]
    clearRetryTimer()
    // Keep one bounded heartbeat while subscribed so drafts created after the
    // initial online pass are discovered without requiring another browser
    // online event. Future backoff deadlines can wake it earlier.
    const delayMs = nextAt
      ? Math.min(boundedRecheckMs, Math.max(0, nextAt - now))
      : boundedRecheckMs
    retryTimer = setTimeout(runRetryPass, delayMs)
  }

  const runRetryPass = () => {
    clearRetryTimer()
    if (disposed || !navigator.onLine) return
    void retryAll(sendFn, options).finally(() => {
      if (!disposed) armNextBackoff()
    })
  }

  const handler = () => runRetryPass()
  window.addEventListener('online', handler)
  // Also try immediately if we're already online
  if (navigator.onLine) {
    // Defer to let the app settle
    retryTimer = setTimeout(runRetryPass, 1000)
  }
  return () => {
    disposed = true
    window.removeEventListener('online', handler)
    clearRetryTimer()
  }
}

function markRetryFailure(item: PendingMessage, lastError?: string): PendingMessage {
  return {
    ...item,
    attempts: item.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    nextRetryAt: undefined,
    lastError,
  }
}

function withRetryDelay(item: PendingMessage): PendingMessage {
  const nextAttempt = Math.max(1, item.attempts)
  const delayMs = Math.min(30_000, 1_000 * 2 ** (nextAttempt - 1))
  return {
    ...item,
    nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
  }
}
