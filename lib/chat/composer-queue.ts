import { resolveUploadFileId } from "./composer-files"

const STORAGE_PREFIX = "sira:chat-composer-queue:v1:"
const MAX_QUEUE_ITEMS = 50
const MAX_MESSAGE_CHARS = 64 * 1024
const MAX_STORAGE_BYTES = 512 * 1024
const MAX_FILE_BYTES = 24 * 1024
const MAX_FILES_PER_ITEM = 24
const MAX_FIELD_STRING_CHARS = 8 * 1024
const MAX_NESTED_DEPTH = 3
const MAX_NESTED_KEYS = 32
const MAX_NESTED_ARRAY_ITEMS = 32

const PERSISTED_FILE_FIELDS = [
  "id",
  "fileId",
  "attachmentId",
  "name",
  "originalName",
  "type",
  "mimeType",
  "size",
  "url",
  "downloadUrl",
  "path",
  "status",
  "uploadStatus",
  "processingStatus",
  "processingStage",
  "sourceChannel",
  "editRegion",
  "longPasteMeta",
] as const

export type PersistedComposerFile = Record<string, unknown>

export interface PersistedComposerQueueItem {
  id: string
  ownerId: string
  chatId: string | null
  msg: string
  files: PersistedComposerFile[]
  idempotencyKey: string
  createdAt: string
}

function storageKey(ownerId: string): string | null {
  const normalized = ownerId.trim()
  return normalized ? `${STORAGE_PREFIX}${encodeURIComponent(normalized)}` : null
}

function cloneJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value
  if (!value || typeof value !== "object" || depth >= MAX_NESTED_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_NESTED_ARRAY_ITEMS)
      .map((entry) => cloneJsonValue(entry, depth + 1))
      .filter((entry) => entry !== undefined)
  }
  const cloned: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_NESTED_KEYS)) {
    const safeEntry = cloneJsonValue(entry, depth + 1)
    if (safeEntry !== undefined) cloned[key] = safeEntry
  }
  return cloned
}

function truncateStrings(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_FIELD_STRING_CHARS)
  if (Array.isArray(value)) return value.map(truncateStrings)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, truncateStrings(entry)]),
  )
}

function encodedBytes(value: unknown): number {
  const json = typeof value === "string" ? value : JSON.stringify(value)
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).byteLength
  return json.length * 2
}

export function serializeComposerQueueFiles(files: unknown[]): PersistedComposerFile[] {
  if (!Array.isArray(files)) return []
  return files.slice(0, MAX_FILES_PER_ITEM).flatMap((file) => {
    if (!file || typeof file !== "object") return []
    const source = file as Record<string, unknown>
    const uploadFileId = resolveUploadFileId(source)
    // A local tempId/file/blob cannot be reconstructed after reload. Persist
    // only attachments that already have the durable backend upload identity
    // accepted by the normal composer send path.
    if (!uploadFileId) return []
    const persisted: PersistedComposerFile = {}
    for (const field of PERSISTED_FILE_FIELDS) {
      const value = truncateStrings(cloneJsonValue(source[field]))
      if (value !== undefined) persisted[field] = value
    }
    if (!persisted.id && !persisted.fileId && !persisted.attachmentId) persisted.id = uploadFileId
    return encodedBytes(persisted) <= MAX_FILE_BYTES ? [persisted] : []
  })
}

export function isUnboundComposerQueueChatId(chatId: string | null | undefined): boolean {
  if (chatId == null) return true
  const value = String(chatId).trim()
  return !value || value.startsWith("temp-chat-")
}

export function adoptUnboundComposerQueueItems(
  items: PersistedComposerQueueItem[],
  realChatId: string,
  previousChatId: string | null = null,
): { items: PersistedComposerQueueItem[]; changed: boolean } {
  const nextId = String(realChatId || "").trim()
  if (!nextId || isUnboundComposerQueueChatId(nextId)) {
    return { items, changed: false }
  }
  let changed = false
  const adopted = items.map((item) => {
    if (
      isUnboundComposerQueueChatId(item.chatId)
      || (previousChatId && item.chatId === previousChatId)
    ) {
      changed = true
      return { ...item, chatId: nextId }
    }
    return item
  })
  return { items: adopted, changed }
}

export function createPersistedComposerQueueItem(input: {
  id: string
  ownerId: string
  chatId: string | null
  msg: string
  files: unknown[]
  idempotencyKey: string
  createdAt?: string
}): PersistedComposerQueueItem {
  return {
    id: input.id,
    ownerId: input.ownerId.trim(),
    chatId: typeof input.chatId === "string" && input.chatId.trim() ? input.chatId : null,
    msg: input.msg.slice(0, MAX_MESSAGE_CHARS),
    files: serializeComposerQueueFiles(input.files),
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

function isPersistedQueueItem(value: unknown, ownerId: string): value is PersistedComposerQueueItem {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<PersistedComposerQueueItem>
  return item.ownerId === ownerId
    && typeof item.id === "string"
    && typeof item.msg === "string"
    && typeof item.idempotencyKey === "string"
    && typeof item.createdAt === "string"
    && (item.chatId === null || typeof item.chatId === "string")
    && Array.isArray(item.files)
}

function sanitizePersistedQueueItem(
  value: unknown,
  ownerId: string,
): PersistedComposerQueueItem | null {
  if (!isPersistedQueueItem(value, ownerId)) return null
  const id = value.id.trim().slice(0, 160)
  const idempotencyKey = value.idempotencyKey.trim().slice(0, 200)
  if (!id || !idempotencyKey) return null
  return createPersistedComposerQueueItem({
    id,
    ownerId,
    chatId: value.chatId,
    msg: value.msg,
    files: value.files,
    idempotencyKey,
    createdAt: value.createdAt.slice(0, 64),
  })
}

export function readPersistedComposerQueue(ownerId: string): PersistedComposerQueueItem[] {
  if (typeof window === "undefined") return []
  const key = storageKey(ownerId)
  if (!key) return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => sanitizePersistedQueueItem(item, ownerId.trim()))
      .filter((item): item is PersistedComposerQueueItem => Boolean(item))
      .slice(-MAX_QUEUE_ITEMS)
  } catch {
    return []
  }
}

export function writePersistedComposerQueue(
  ownerId: string,
  items: PersistedComposerQueueItem[],
): boolean {
  if (typeof window === "undefined") return false
  const normalizedOwner = ownerId.trim()
  const key = storageKey(normalizedOwner)
  if (!key) return false
  const safeItems = items
    .map((item) => sanitizePersistedQueueItem(item, normalizedOwner))
    .filter((item): item is PersistedComposerQueueItem => Boolean(item))
    .slice(-MAX_QUEUE_ITEMS)
  try {
    if (safeItems.length === 0) window.localStorage.removeItem(key)
    else {
      // Retain newest tasks if storage is under pressure. The queue remains
      // ordered, bounded and far below common browser localStorage quotas.
      let boundedItems = safeItems
      let serialized = JSON.stringify(boundedItems)
      while (boundedItems.length > 1 && encodedBytes(serialized) > MAX_STORAGE_BYTES) {
        boundedItems = boundedItems.slice(1)
        serialized = JSON.stringify(boundedItems)
      }
      if (encodedBytes(serialized) > MAX_STORAGE_BYTES) return false
      window.localStorage.setItem(key, serialized)
    }
    return true
  } catch {
    return false
  }
}

export function clearPersistedComposerQueues(): void {
  if (typeof window === "undefined") return
  try {
    const keys: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // Storage can be unavailable in private browsing. The in-memory queue
    // remains functional for the current tab.
  }
}
