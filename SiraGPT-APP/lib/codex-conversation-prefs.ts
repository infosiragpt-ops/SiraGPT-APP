"use client"

/**
 * Codex sidebar preferences — display options (grouping/sorting/subtitles)
 * and per-conversation client-side state (pinned / archived / read).
 *
 * All state is localStorage-only and broadcast via CODEX_PREFS_UPDATED_EVENT
 * so every mounted sidebar instance stays in sync within the tab. Conversation
 * rows are keyed as `${source}:${id}` (source = "code" | "cloud").
 */

export type CodexGroupBy = "project" | "status" | "none"
export type CodexSort = "updated" | "alphabetical" | "created"
export type CodexSubtitles = "worktree" | "none"

export type CodexDisplayOptions = {
  groupBy: CodexGroupBy
  sort: CodexSort
  subtitles: CodexSubtitles
}

export const DEFAULT_DISPLAY_OPTIONS: CodexDisplayOptions = {
  groupBy: "project",
  sort: "updated",
  subtitles: "none",
}

export const CODEX_PREFS_UPDATED_EVENT = "siragpt:codex-prefs-updated"

const DISPLAY_KEY = "codex:display-options"
const PINNED_KEY = "codex:pinned-rows"
const ARCHIVED_KEY = "codex:archived-rows"
const READ_KEY = "codex:read-rows"

export function rowKey(source: "code" | "cloud", id: string): string {
  return `${source}:${id}`
}

function storage(): Storage | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return globalThis.localStorage as Storage
    }
  } catch {
    /* private mode / denied */
  }
  return null
}

function emit() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CODEX_PREFS_UPDATED_EVENT))
  }
}

function readStringArray(key: string): string[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(key) || "[]")
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

function writeStringSet(key: string, set: Set<string>) {
  const store = storage()
  if (!store) return
  try {
    store.setItem(key, JSON.stringify(Array.from(set)))
  } catch {
    /* quota — fail soft */
  }
  emit()
}

export function getDisplayOptions(): CodexDisplayOptions {
  const store = storage()
  if (!store) return { ...DEFAULT_DISPLAY_OPTIONS }
  try {
    const parsed = JSON.parse(store.getItem(DISPLAY_KEY) || "{}") as Partial<CodexDisplayOptions>
    return {
      groupBy: parsed.groupBy ?? DEFAULT_DISPLAY_OPTIONS.groupBy,
      sort: parsed.sort ?? DEFAULT_DISPLAY_OPTIONS.sort,
      subtitles: parsed.subtitles ?? DEFAULT_DISPLAY_OPTIONS.subtitles,
    }
  } catch {
    return { ...DEFAULT_DISPLAY_OPTIONS }
  }
}

export function setDisplayOption<K extends keyof CodexDisplayOptions>(
  key: K,
  value: CodexDisplayOptions[K],
): CodexDisplayOptions {
  const next = { ...getDisplayOptions(), [key]: value }
  const store = storage()
  if (store) {
    try {
      store.setItem(DISPLAY_KEY, JSON.stringify(next))
    } catch {
      /* fail soft */
    }
  }
  emit()
  return next
}

export function getPinnedRows(): Set<string> {
  return new Set(readStringArray(PINNED_KEY))
}

export function getArchivedRows(): Set<string> {
  return new Set(readStringArray(ARCHIVED_KEY))
}

export function getReadRows(): Set<string> {
  return new Set(readStringArray(READ_KEY))
}

export function togglePinnedRow(key: string): Set<string> {
  const set = getPinnedRows()
  if (set.has(key)) set.delete(key)
  else set.add(key)
  writeStringSet(PINNED_KEY, set)
  return set
}

export function toggleArchivedRow(key: string): Set<string> {
  const set = getArchivedRows()
  if (set.has(key)) set.delete(key)
  else set.add(key)
  writeStringSet(ARCHIVED_KEY, set)
  return set
}

export function markRowRead(key: string): Set<string> {
  const set = getReadRows()
  set.add(key)
  writeStringSet(READ_KEY, set)
  return set
}

export function markRowUnread(key: string): Set<string> {
  const set = getReadRows()
  set.delete(key)
  writeStringSet(READ_KEY, set)
  return set
}

/** Drop a row from every preference set (used when a conversation is deleted). */
export function forgetRow(key: string) {
  for (const storeKey of [PINNED_KEY, ARCHIVED_KEY, READ_KEY]) {
    const set = new Set(readStringArray(storeKey))
    if (set.delete(key)) writeStringSet(storeKey, set)
  }
}
