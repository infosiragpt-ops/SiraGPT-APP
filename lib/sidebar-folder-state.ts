import { chatFolderKey, normalizeChatFolderName } from "./sidebar-chat-folders"

export const SIDEBAR_FOLDER_SETTINGS_KEY = "sidebarChatFolders"
export const SIDEBAR_FOLDER_MIGRATION_KEY = "sira:chat-folders:migrated-account"
export const SIDEBAR_FOLDER_LEGACY_NAMES_KEY = "sira:chat-folders:legacy-names-imported"

export type SidebarFolderMetadata = { isPinned?: boolean; description?: string }
export type SidebarFolderState = {
  assignments: Record<string, string>
  names: string[]
  metadata: Record<string, SidebarFolderMetadata>
  unreadIds: string[]
  sections: string[]
  chatSections: Record<string, string>
}

// Arrays are intentional: /users/settings merges objects recursively but
// replaces arrays. Sending an empty array must really remove old assignments.
export type SidebarFolderSnapshot = {
  version: 1
  folders: Array<{ name: string; isPinned: boolean; description: string }>
  assignments: Array<{ chatId: string; folder: string }>
  unreadIds: string[]
  sections: string[]
  chatSections: Array<{ chatId: string; section: string }>
}

export function emptySidebarFolderState(): SidebarFolderState {
  return { assignments: {}, names: [], metadata: {}, unreadIds: [], sections: [], chatSections: {} }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function safeKey(value: unknown): string {
  if (typeof value !== "string") return ""
  const key = value.trim()
  return key && key.length <= 256 && !["__proto__", "constructor", "prototype"].includes(key.toLowerCase()) ? key : ""
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? safeKey(normalizeChatFolderName(value)) : ""
}

function uniqueNames(values: unknown[]): string[] {
  const names = new Map<string, string>()
  for (const value of values) {
    const name = cleanName(value)
    if (name && !names.has(chatFolderKey(name))) names.set(chatFolderKey(name), name)
  }
  return [...names.values()]
}

export function normalizeSidebarFolderState(value: unknown): SidebarFolderState {
  const input = record(value)
  const rawAssignments = record(input.assignments)
  const names = uniqueNames([...(Array.isArray(input.names) ? input.names : []), ...Object.values(rawAssignments)])
  const canonical = new Map(names.map(name => [chatFolderKey(name), name]))
  const assignments: Record<string, string> = {}
  for (const [id, name] of Object.entries(rawAssignments)) {
    const chatId = safeKey(id)
    const folder = canonical.get(chatFolderKey(cleanName(name)))
    if (chatId && folder) assignments[chatId] = folder
  }
  const metadata: Record<string, SidebarFolderMetadata> = {}
  for (const [name, raw] of Object.entries(record(input.metadata))) {
    const key = chatFolderKey(cleanName(name))
    if (!canonical.has(key)) continue
    const item = record(raw)
    metadata[key] = {
      isPinned: item.isPinned === true,
      description: typeof item.description === "string" ? item.description.trim().slice(0, 4000) : "",
    }
  }
  const sections = uniqueNames(Array.isArray(input.sections) ? input.sections : [])
  const sectionNames = new Map(sections.map(name => [chatFolderKey(name), name]))
  const chatSections: Record<string, string> = {}
  for (const [id, name] of Object.entries(record(input.chatSections))) {
    const chatId = safeKey(id)
    const section = sectionNames.get(chatFolderKey(cleanName(name)))
    if (chatId && section) chatSections[chatId] = section
  }
  const unreadIds = [...new Set((Array.isArray(input.unreadIds) ? input.unreadIds : []).map(safeKey).filter(Boolean))]
  return { assignments, names, metadata, unreadIds, sections, chatSections }
}

export function serializeSidebarFolderState(value: SidebarFolderState): SidebarFolderSnapshot {
  const state = normalizeSidebarFolderState(value)
  return {
    version: 1,
    folders: state.names.map(name => ({
      name,
      isPinned: state.metadata[chatFolderKey(name)]?.isPinned === true,
      description: state.metadata[chatFolderKey(name)]?.description || "",
    })),
    assignments: Object.entries(state.assignments).map(([chatId, folder]) => ({ chatId, folder })),
    unreadIds: state.unreadIds,
    sections: state.sections,
    chatSections: Object.entries(state.chatSections).map(([chatId, section]) => ({ chatId, section })),
  }
}

export function isSidebarFolderSnapshot(value: unknown): value is SidebarFolderSnapshot {
  const input = record(value)
  return input.version === 1 && Array.isArray(input.folders) && Array.isArray(input.assignments)
}

export function deserializeSidebarFolderState(value: unknown): SidebarFolderState {
  if (!isSidebarFolderSnapshot(value)) return emptySidebarFolderState()
  const folders = value.folders.map(record)
  return normalizeSidebarFolderState({
    names: folders.map(folder => folder.name),
    metadata: Object.fromEntries(folders.flatMap(folder => {
      const name = cleanName(folder.name)
      return name ? [[chatFolderKey(name), folder]] : []
    })),
    assignments: Object.fromEntries(value.assignments.map(record).flatMap(item => {
      const id = safeKey(item.chatId)
      return id ? [[id, item.folder]] : []
    })),
    unreadIds: value.unreadIds,
    sections: value.sections,
    chatSections: Object.fromEntries((Array.isArray(value.chatSections) ? value.chatSections : []).map(record).flatMap(item => {
      const id = safeKey(item.chatId)
      return id ? [[id, item.section]] : []
    })),
  })
}

export function migrateLegacySidebarFolders(assignments: unknown, knownChatIds: readonly string[]): SidebarFolderState {
  const owned = new Set(knownChatIds.map(safeKey).filter(Boolean))
  const retained = Object.fromEntries(Object.entries(record(assignments)).filter(([id]) => owned.has(id)))
  // Unassigned legacy names have no owner evidence and must never cross accounts.
  return normalizeSidebarFolderState({ assignments: retained })
}

export function sidebarFolderCacheKey(userId: string): string {
  return `sira:sidebar-folders:v1:${encodeURIComponent(userId)}`
}

export function sidebarFolderMigrationLedgerKey(userId: string): string {
  return `sira:chat-folders:migrated-ids:${encodeURIComponent(userId)}`
}

export function importLegacyFolderNames(state: SidebarFolderState, names: unknown): SidebarFolderState {
  return normalizeSidebarFolderState({
    ...state,
    names: [...state.names, ...(Array.isArray(names) ? names : [])],
  })
}

export function withoutSidebarFolderSettings<T extends object>(settings: T): Omit<T, "sidebarChatFolders"> {
  const { sidebarChatFolders: _dedicatedState, ...rest } = settings as T & { sidebarChatFolders?: unknown }
  return rest
}
