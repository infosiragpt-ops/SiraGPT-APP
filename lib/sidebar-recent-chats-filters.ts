export type RecentChatTypeFilter = "all" | "chats" | "scheduled"
export type RecentChatStatusFilter = "active" | "archived" | "pinned"
export type RecentChatActivityFilter = "all" | "today" | "yesterday" | "last7Days"
export type RecentChatGroupBy = "date" | "none"

export type RecentChatLike = {
  id: string
  title?: string
  updatedAt?: string
  deletedAt?: unknown
  isArchived?: boolean
  isPinned?: boolean
}

export const RECENT_CHAT_TYPE_LABELS: Record<RecentChatTypeFilter, string> = {
  all: "Todo",
  chats: "Chats",
  scheduled: "Programados",
}

export const RECENT_CHAT_STATUS_LABELS: Record<RecentChatStatusFilter, string> = {
  active: "Activo",
  archived: "Archivados",
  pinned: "Fijados",
}

export const RECENT_CHAT_ACTIVITY_LABELS: Record<RecentChatActivityFilter, string> = {
  all: "Todo",
  today: "Hoy",
  yesterday: "Ayer",
  last7Days: "Últimos 7 días",
}

export const RECENT_CHAT_GROUP_LABELS: Record<RecentChatGroupBy, string> = {
  date: "Fecha",
  none: "Ninguno",
}

const DAY_MS = 24 * 60 * 60 * 1000

export function startOfLocalDay(now = Date.now()): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function chatActivityBucket(
  updatedAt: string | undefined,
  now = Date.now(),
): Exclude<RecentChatActivityFilter, "all"> | "older" {
  const startOfToday = startOfLocalDay(now)
  const ts = new Date(updatedAt || 0).getTime()
  if (!Number.isFinite(ts)) return "older"
  if (ts >= startOfToday) return "today"
  if (ts >= startOfToday - DAY_MS) return "yesterday"
  if (ts >= now - 7 * DAY_MS) return "last7Days"
  return "older"
}

export function matchesRecentChatQuery(title: string | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return String(title || "").toLowerCase().includes(needle)
}

function toIdSet(ids: Iterable<string> | Record<string, unknown>): Set<string> {
  if (ids instanceof Set) return ids
  if (Array.isArray(ids)) return new Set(ids)
  if (ids && typeof ids === "object" && typeof (ids as Iterable<string>)[Symbol.iterator] === "function") {
    return new Set(ids as Iterable<string>)
  }
  return new Set(Object.keys(ids || {}))
}

export function filterRecentChats<T extends RecentChatLike>(
  chats: T[],
  opts: {
    type?: RecentChatTypeFilter
    status?: RecentChatStatusFilter
    activity?: RecentChatActivityFilter
    query?: string
    archivedIds?: Iterable<string>
    hiddenIds?: Iterable<string>
    scheduledIds?: Iterable<string> | Record<string, unknown>
    isPinned?: (chat: T) => boolean
    now?: number
  } = {},
): T[] {
  const type = opts.type ?? "all"
  const status = opts.status ?? "active"
  const activity = opts.activity ?? "all"
  const archived = new Set(opts.archivedIds ?? [])
  const hidden = new Set(opts.hiddenIds ?? [])
  const scheduled = toIdSet(opts.scheduledIds ?? [])
  const isPinned = opts.isPinned ?? ((chat: T) => Boolean(chat.isPinned))
  const now = opts.now ?? Date.now()
  const seen = new Set<string>()

  return chats.filter((chat) => {
    if (!chat?.id || seen.has(chat.id)) return false
    seen.add(chat.id)
    if (chat.deletedAt) return false

    const isArchived = Boolean(chat.isArchived) || archived.has(chat.id)
    const isHidden = hidden.has(chat.id)
    const isScheduled = scheduled.has(chat.id)
    const pinned = isPinned(chat)

    if (status === "active") {
      if (isArchived || isHidden) return false
    } else if (status === "archived") {
      if (!isArchived) return false
    } else if (status === "pinned") {
      if (!pinned || isHidden) return false
    }

    if (type === "scheduled" && !isScheduled) return false
    if (type === "chats" && isScheduled) return false

    if (activity !== "all" && chatActivityBucket(chat.updatedAt, now) !== activity) {
      return false
    }

    return matchesRecentChatQuery(chat.title, opts.query || "")
  })
}

export function sortChatsNewestFirst<T extends { updatedAt?: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
  )
}

export function groupRecentChatsByDate<T extends { updatedAt?: string }>(
  items: T[],
  now = Date.now(),
): Record<"today" | "yesterday" | "last7Days" | "older", T[]> {
  const buckets: Record<"today" | "yesterday" | "last7Days" | "older", T[]> = {
    today: [],
    yesterday: [],
    last7Days: [],
    older: [],
  }
  for (const chat of items) {
    buckets[chatActivityBucket(chat.updatedAt, now)].push(chat)
  }
  return buckets
}
