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
 *
 * CROSS-TAB SAFETY (drafts live in shared localStorage):
 *   - The tab streaming a turn holds an in-flight lease on its draft
 *     (`markTurnInFlight` / `refreshTurnLease` / `releaseTurnLease`); no other
 *     tab replays a leased draft, and a crashed tab's lease simply expires.
 *   - One leader tab per owner runs retry passes (Web Locks when available,
 *     else a short localStorage lease).
 *   - A turn that failed for a non-retryable reason (`markTurnTerminal`) and
 *     any draft older than 15 minutes stay for a manual retry only.
 *
 * ONE RETRY PATH PER TURN: a newer send in the same chat supersedes older
 * drafts (`supersedeOtherTurns`), a regenerate / edit drops the drafts of the
 * turns it replaces (`clearTurnsForMessages`), and a replay is skipped when
 * the conversation already answered or moved past the turn
 * (`pendingTurnReplayState`).
 */

const STORAGE_KEY = 'sira_pending_messages'
const LEADER_KEY_PREFIX = 'sira_pending_retry_leader:'

/**
 * In-flight lease of the tab streaming a turn. Refreshed by a timer AND by
 * stream activity; long enough to survive Chrome's intensive throttling of
 * hidden tabs (chained timers fire about once a minute), short enough that
 * a crashed tab's turn is picked up again within a few minutes.
 */
export const TURN_LEASE_TTL_MS = 150_000
/** Retry-pass leader lease (localStorage fallback when Web Locks are missing or fail). */
export const RETRY_LEADER_TTL_MS = 10_000
/** Drafts older than this are never replayed automatically. */
export const AUTO_REPLAY_MAX_AGE_MS = 15 * 60_000
/** Terminal (manual-only) drafts are dropped from storage after a day. */
export const TERMINAL_DRAFT_TTL_MS = 24 * 60 * 60_000
/** The browser 'online' event fires in every tab at once: spread them out. */
export const ONLINE_RETRY_JITTER_MS = 1_500
/** Automatic replay backoff ceiling (server Retry-After hints included). */
export const PENDING_RETRY_MAX_DELAY_MS = 60_000

function createTabId(): string {
  try {
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  } catch { /* fall through */ }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const TAB_ID = createTabId()

/** Stable id of this tab (module instance) for turn and leader leases. */
export function getPendingTabId(): string {
  return TAB_ID
}

export type PendingRetryResult = 'success' | 'failure' | 'defer'

export interface PendingRetryOptions {
  ownerId?: string
}

export interface PendingAIRequestEnvelope {
  provider: string
  model: string
  /** Image picker settings are independent of the conversation model. */
  imageModel?: string
  imageProvider?: string
  imageQuality?: string
  reasoningEffort?: string
  permission?: string
  regenerate?: boolean
  regenerationAttempt?: number
  codingWorkspace?: boolean
  disableAgentic?: boolean
  enableWebGrounding?: boolean
  webGroundingQuery?: string
  webSearchMode?: string
  mentionedApps?: string[]
  /** Persistent app pins — replayed on every turn of the conversation. */
  pinnedAppIds?: string[]
  /** Agent Skills picked in the composer («+ → Skills») for this turn. */
  skills?: string[]
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
  /** Epoch ms until which the tab streaming this turn holds it. */
  inFlightUntil?: number
  /** Tab that holds the in-flight lease. */
  inFlightTabId?: string
  /** Set by markTurnTerminal: kept for a manual retry, never auto-replayed. */
  terminalKind?: string
  /** Server retry hint (ms) recorded for the next automatic replay. */
  retryAfterMs?: number
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
  const now = Date.now()
  // Replace only the same logical turn. Two tabs can legitimately own
  // different keys in one chat; clearing/replacing K1 must never delete K2.
  // Terminal drafts older than a day are never replayed: drop them here so
  // storage does not grow without bound.
  const filtered = all.filter((message) => !(
    message.chatId === chatId
      && message.idempotencyKey === item.idempotencyKey
      && message.ownerId === item.ownerId
  ) && !isExpiredTerminalDraft(message, now))
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

  const matchesIdentity = turnIdentityMatcher(pending)

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

function turnIdentityMatcher(
  pending: Pick<PendingMessage, 'idempotencyKey' | 'turnKey' | 'streamId'>,
): (message: { metadata?: unknown }) => boolean {
  const idempotencyKey = normalizeIdempotencyKey(pending.idempotencyKey)
  const legacyStreamId = normalizeIdempotencyKey(pending.streamId || pending.turnKey)
  return (message) => {
    const metadata = parseMetadata(message?.metadata)
    const storedIdempotencyKey = normalizeIdempotencyKey(metadata.idempotencyKey)
    if (idempotencyKey && storedIdempotencyKey === idempotencyKey) return true
    if (!legacyStreamId) return false
    return normalizeIdempotencyKey(metadata.streamId) === legacyStreamId
      || storedIdempotencyKey === legacyStreamId
  }
}

export type PendingTurnReplayState = 'replay' | 'answered' | 'superseded'

/**
 * What an automatic replay of `pending` would do to this conversation:
 *  - 'answered': its own reply has content, or another ASSISTANT row (a
 *    regeneration, a row without turn identity) already follows its USER
 *    row. The draft is done; never POST it again.
 *  - 'superseded': a later USER turn exists, so a replay would answer the
 *    old turn out of order.
 *  - 'replay': no reply yet (or only its own failed placeholder).
 */
export function pendingTurnReplayState(
  messages: Array<{ role?: unknown; content?: unknown; metadata?: unknown }> | null | undefined,
  pending: Pick<PendingMessage, 'idempotencyKey' | 'turnKey' | 'streamId'>,
): PendingTurnReplayState {
  const match = findPendingTurnMatch(messages, pending)
  if (match.hasAssistantReply) return 'answered'
  if (!Array.isArray(messages) || match.userIndex === -1) return 'replay'
  const matchesIdentity = turnIdentityMatcher(pending)
  for (let index = match.userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    const role = String(message?.role || '').toUpperCase()
    if (role === 'USER') return 'superseded'
    if (role === 'ASSISTANT' && !matchesIdentity(message)) return 'answered'
  }
  return 'replay'
}

/** Turn keys (idempotency keys) carried by these messages' metadata. */
export function turnKeysOfMessages(
  messages: Array<{ metadata?: unknown }> | null | undefined,
): string[] {
  if (!Array.isArray(messages)) return []
  const keys = new Set<string>()
  for (const message of messages) {
    const metadata = parseMetadata(message?.metadata)
    const key = normalizeIdempotencyKey(metadata.idempotencyKey)
    if (key) keys.add(key)
  }
  return [...keys]
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

/**
 * Drop the drafts of the turns these messages belong to (a regenerate or an
 * edit replaces them: their old key must never be replayed afterwards).
 */
export function clearTurnsForMessages(
  chatId: string,
  messages: Array<{ metadata?: unknown }> | null | undefined,
  ownerId?: string,
): number {
  const keys = new Set(turnKeysOfMessages(messages))
  if (keys.size === 0) return 0
  const normalizedOwner = ownerId?.trim() || null
  const all = getAllRaw()
  const kept = all.filter((message) => !(
    message.chatId === chatId
      && keys.has(message.idempotencyKey)
      && (!normalizedOwner || message.ownerId === normalizedOwner)
  ))
  if (kept.length !== all.length) persistAll(kept)
  return all.length - kept.length
}

/**
 * A newer turn was just sent in this chat: every older draft of the chat
 * becomes manual (`terminalKind: 'superseded'`) so it is never answered
 * after the newer one.
 */
export function supersedeOtherTurns(
  chatId: string,
  keepIdempotencyKey: string,
  ownerId?: string,
): number {
  const keep = normalizeIdempotencyKey(keepIdempotencyKey)
  const normalizedOwner = ownerId?.trim() || null
  let changed = 0
  const next = getAllRaw().map((item) => {
    if (
      item.chatId !== chatId
      || item.idempotencyKey === keep
      || (normalizedOwner && item.ownerId !== normalizedOwner)
      || item.terminalKind
    ) return item
    changed += 1
    return {
      ...item,
      retryPolicy: 'manual' as const,
      terminalKind: 'superseded',
      lastError: 'superseded',
      nextRetryAt: undefined,
    }
  })
  if (changed > 0) persistAll(next)
  return changed
}

/** The stored draft of one turn, read fresh from storage (undefined when gone). */
export function getTurn(chatId: string, idempotencyKey: string, ownerId?: string): PendingMessage | undefined {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) return undefined
  const normalizedOwner = ownerId?.trim() || null
  return getAllRaw().find((message) => (
    message.chatId === chatId
      && message.idempotencyKey === normalizedKey
      && (!normalizedOwner || message.ownerId === normalizedOwner)
  ))
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

/* ------------------------------------------------------------------ */
/*  Turn leases (cross-tab)                                            */
/* ------------------------------------------------------------------ */

function updateTurn(
  chatId: string,
  idempotencyKey: string,
  ownerId: string | undefined,
  update: (item: PendingMessage) => PendingMessage | null,
): PendingMessage | undefined {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) return undefined
  const normalizedOwner = ownerId?.trim() || null
  let updatedItem: PendingMessage | undefined
  let changed = false
  const next = getAllRaw().map((item) => {
    if (
      item.chatId !== chatId
      || item.idempotencyKey !== normalizedKey
      || (normalizedOwner && item.ownerId !== normalizedOwner)
    ) return item
    const updated = update(item)
    if (!updated) return item
    changed = true
    updatedItem = updated
    return updated
  })
  if (changed) persistAll(next)
  return updatedItem
}

/**
 * The tab about to stream this turn claims it. Other tabs will not replay the
 * draft while the lease is live; a crashed tab's lease expires on its own.
 */
export function markTurnInFlight(
  chatId: string,
  idempotencyKey: string,
  ownerId?: string,
  tabId: string = TAB_ID,
  ttlMs: number = TURN_LEASE_TTL_MS,
): PendingMessage | undefined {
  const until = Date.now() + Math.max(1_000, ttlMs)
  return updateTurn(chatId, idempotencyKey, ownerId, (item) => ({
    ...item,
    inFlightUntil: until,
    inFlightTabId: tabId,
  }))
}

/** Extend this tab's lease while the turn keeps streaming. */
export function refreshTurnLease(
  chatId: string,
  idempotencyKey: string,
  ownerId?: string,
  tabId: string = TAB_ID,
  ttlMs: number = TURN_LEASE_TTL_MS,
): PendingMessage | undefined {
  const now = Date.now()
  return updateTurn(chatId, idempotencyKey, ownerId, (item) => {
    if (isTurnLeaseLive(item, now) && item.inFlightTabId !== tabId) return null
    return { ...item, inFlightUntil: now + Math.max(1_000, ttlMs), inFlightTabId: tabId }
  })
}

/** Drop this tab's lease (the stream ended, whatever the outcome). */
export function releaseTurnLease(
  chatId: string,
  idempotencyKey: string,
  ownerId?: string,
  tabId: string = TAB_ID,
): PendingMessage | undefined {
  return updateTurn(chatId, idempotencyKey, ownerId, (item) => {
    if (item.inFlightTabId && item.inFlightTabId !== tabId) return null
    if (item.inFlightUntil === undefined && item.inFlightTabId === undefined) return null
    const { inFlightUntil: _until, inFlightTabId: _tab, ...rest } = item
    return rest
  })
}

export function isTurnLeaseLive(
  item: Pick<PendingMessage, 'inFlightUntil' | 'inFlightTabId'> | null | undefined,
  now: number = Date.now(),
): boolean {
  const until = Number(item?.inFlightUntil)
  return Boolean(item?.inFlightTabId) && Number.isFinite(until) && until > now
}

/** Another live tab is streaming this turn right now (fresh storage read). */
export function isTurnLeasedByAnotherTab(
  chatId: string,
  idempotencyKey: string,
  ownerId?: string,
  tabId: string = TAB_ID,
  now: number = Date.now(),
): boolean {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) return false
  const normalizedOwner = ownerId?.trim() || null
  return getAllRaw().some((item) => (
    item.chatId === chatId
      && item.idempotencyKey === normalizedKey
      && (!normalizedOwner || item.ownerId === normalizedOwner)
      && isTurnLeaseLive(item, now)
      && item.inFlightTabId !== tabId
  ))
}

/**
 * The turn failed for a reason a replay cannot fix (plan quota, provider
 * failure, conflict, invalid request). The draft is kept for a manual
 * «Reintentar» but is never replayed automatically.
 */
export function markTurnTerminal(
  chatId: string,
  idempotencyKey: string,
  ownerId: string | undefined,
  kind: string,
): PendingMessage | undefined {
  const reason = String(kind || 'terminal').slice(0, 80)
  return updateTurn(chatId, idempotencyKey, ownerId, (item) => ({
    ...item,
    retryPolicy: 'manual',
    terminalKind: reason,
    lastError: reason,
    nextRetryAt: undefined,
  }))
}

/**
 * A retryable failure (network, rate limit, restart…) keeps the draft
 * automatic, but its next replay waits at least the server hint.
 */
export function scheduleTurnRetry(
  chatId: string,
  idempotencyKey: string,
  ownerId: string | undefined,
  options: { retryAfterMs?: number | null; minDelayMs?: number; lastError?: string } = {},
): PendingMessage | undefined {
  const hint = Number(options.retryAfterMs)
  const hintMs = Number.isFinite(hint) && hint > 0 ? Math.min(PENDING_RETRY_MAX_DELAY_MS, hint) : 0
  const delayMs = Math.min(PENDING_RETRY_MAX_DELAY_MS, Math.max(hintMs, options.minDelayMs ?? 0))
  return updateTurn(chatId, idempotencyKey, ownerId, (item) => {
    if (item.terminalKind) return null
    return {
      ...item,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      ...(hintMs > 0 ? { retryAfterMs: hintMs } : {}),
      ...(options.lastError ? { lastError: String(options.lastError).slice(0, 80) } : {}),
    }
  })
}

function isExpiredTerminalDraft(item: PendingMessage, now: number): boolean {
  if (!item.terminalKind) return false
  const created = Date.parse(item.createdAt)
  return Number.isFinite(created) && now - created > TERMINAL_DRAFT_TTL_MS
}

function isTooOldForAutoReplay(item: PendingMessage, now: number): boolean {
  const created = Date.parse(item.createdAt)
  return Number.isFinite(created) && now - created > AUTO_REPLAY_MAX_AGE_MS
}

/* ------------------------------------------------------------------ */
/*  Retry-pass leader (one tab per owner)                              */
/* ------------------------------------------------------------------ */

type LeaderRecord = { tabId: string; until: number }

function readLeader(key: string): LeaderRecord | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.tabId === 'string' && Number.isFinite(Number(parsed.until))) {
      return { tabId: parsed.tabId, until: Number(parsed.until) }
    }
  } catch { /* corrupt → free */ }
  return null
}

/** localStorage fallback lease. Storage unavailable → run (nothing to share). */
function tryAcquireLeaderLease(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return true
    const now = Date.now()
    const current = readLeader(key)
    if (current && current.until > now && current.tabId !== TAB_ID) return false
    localStorage.setItem(key, JSON.stringify({ tabId: TAB_ID, until: now + RETRY_LEADER_TTL_MS }))
    return readLeader(key)?.tabId === TAB_ID
  } catch {
    return true
  }
}

function refreshLeaderLease(key: string): void {
  try {
    if (readLeader(key)?.tabId !== TAB_ID) return
    localStorage.setItem(key, JSON.stringify({ tabId: TAB_ID, until: Date.now() + RETRY_LEADER_TTL_MS }))
  } catch { /* best effort */ }
}

function releaseLeaderLease(key: string): void {
  try {
    if (readLeader(key)?.tabId === TAB_ID) localStorage.removeItem(key)
  } catch { /* best effort */ }
}

type WebLocks = {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>
}

function webLocks(): WebLocks | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: WebLocks } }).navigator?.locks
    return locks && typeof locks.request === 'function' ? locks : null
  } catch {
    return null
  }
}

async function runAsRetryLeader<T>(scope: string, run: () => Promise<T>, skipped: () => T): Promise<T> {
  const key = `${LEADER_KEY_PREFIX}${scope}`
  const locks = webLocks()
  if (locks) {
    let result: T | undefined
    let ran = false
    let lockFailed = false
    try {
      await locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) return
        ran = true
        result = await run()
      })
    } catch (error) {
      // The pass itself failed: surface it like the storage path does.
      if (ran) throw error
      // The Locks API refused (opaque origin, sandboxed frame…): fall back
      // to the localStorage lease instead of never running a pass.
      lockFailed = true
    }
    if (!lockFailed) return ran ? (result as T) : skipped()
  }
  if (!tryAcquireLeaderLease(key)) return skipped()
  const heartbeat = setInterval(() => refreshLeaderLease(key), Math.floor(RETRY_LEADER_TTL_MS / 3))
  try {
    return await run()
  } finally {
    clearInterval(heartbeat)
    releaseLeaderLease(key)
  }
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
  // Only one tab per owner runs a pass; the others count and wait.
  retryPromise = runAsRetryLeader(
    retryScope,
    () => retryAllInternal(sendFn, options),
    () => ({ retried: 0, stillPending: countPendingFor(options.ownerId) }),
  ).finally(() => {
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
    // Terminal failures and stale drafts are manual only; a turn another tab
    // (or this one) is streaming is deferred without spending an attempt.
    if (item.terminalKind || isTooOldForAutoReplay(item, now) || isTurnLeaseLive(item, now)) {
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
        persistRetryFailure(item)
        stillPending++
      }
    } catch (error) {
      // Failed this attempt — keep in storage for next retry
      persistRetryFailure(item, error instanceof Error ? error.message : 'send_failed')
      stillPending++
    }
  }

  return { retried, stillPending }
}

function countPendingFor(ownerId?: string): number {
  const owner = ownerId?.trim() || null
  return getAllRaw().filter((item) => !owner || item.ownerId === owner).length
}

/**
 * Count a failed replay on the CURRENT stored draft: the send itself may have
 * marked it terminal or scheduled it, and a stale snapshot must never undo
 * that (nor resurrect a draft that was cleared).
 */
function persistRetryFailure(item: PendingMessage, lastError?: string): void {
  const all = getAllRaw()
  const current = all.find((m) => m.id === item.id)
  if (!current) return
  const failedItem = markRetryFailure(current, lastError ?? current.lastError)
  const delayed = withRetryDelay(failedItem)
  const scheduledAt = current.nextRetryAt ? Date.parse(current.nextRetryAt) : Number.NaN
  const next = Number.isFinite(scheduledAt) && scheduledAt > Date.parse(delayed.nextRetryAt || '')
    ? { ...delayed, nextRetryAt: current.nextRetryAt }
    : delayed
  persistAll(all.map((m) => (m.id === item.id ? next : m)))
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

  // Every tab receives 'online' in the same instant: a random 0-1.5 s delay
  // (plus the leader lease) keeps them from replaying in lockstep.
  const handler = () => {
    clearRetryTimer()
    if (disposed) return
    retryTimer = setTimeout(runRetryPass, Math.floor(Math.random() * ONLINE_RETRY_JITTER_MS))
  }
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

/**
 * Full-jitter backoff for the next automatic replay, never earlier than a
 * recorded server Retry-After hint, capped at 60 s.
 */
function withRetryDelay(item: PendingMessage): PendingMessage {
  const nextAttempt = Math.max(1, item.attempts)
  const ceiling = Math.min(PENDING_RETRY_MAX_DELAY_MS, 1_000 * 2 ** (nextAttempt - 1))
  const jittered = Math.floor(Math.random() * ceiling)
  const hint = Number(item.retryAfterMs)
  const floor = Number.isFinite(hint) && hint > 0 ? Math.min(PENDING_RETRY_MAX_DELAY_MS, hint) : 0
  const delayMs = Math.min(PENDING_RETRY_MAX_DELAY_MS, Math.max(floor, jittered))
  return {
    ...item,
    nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
  }
}
