export const CHAT_FOLDERS_STORAGE_KEY = "sira:chat-folders"
export const CHAT_FOLDER_NAMES_STORAGE_KEY = "sira:chat-folder-names"

export const SUGGESTED_CHAT_FOLDERS = ["Trabajo", "Empresa", "Personal"] as const

/** text/plain prefix so Safari/Chrome accept the drag payload. */
export const CHAT_FOLDER_DRAG_PREFIX = "siragpt-chat:"

export function normalizeChatFolderName(name: string): string {
  return name.replace(/\s+/g, " ").trim()
}

export function chatFolderKey(name: string): string {
  return normalizeChatFolderName(name).toLowerCase()
}

export function isSameChatFolder(a: string, b: string): boolean {
  const left = chatFolderKey(a)
  const right = chatFolderKey(b)
  return Boolean(left) && left === right
}

export function encodeChatFolderDragId(chatId: string): string {
  return `${CHAT_FOLDER_DRAG_PREFIX}${chatId}`
}

export function decodeChatFolderDragId(raw: unknown): string | null {
  const value = String(raw || "")
  if (!value.startsWith(CHAT_FOLDER_DRAG_PREFIX)) return null
  const id = value.slice(CHAT_FOLDER_DRAG_PREFIX.length).trim()
  return id || null
}

export function countChatsInFolder(
  assignments: Record<string, string> | null | undefined,
  folder: string,
): number {
  const key = chatFolderKey(folder)
  if (!key) return 0
  let count = 0
  for (const name of Object.values(assignments || {})) {
    if (name.toLowerCase() === key) count += 1
  }
  return count
}

export function filterChatsByFolder<T extends { id: string }>(
  chats: T[],
  assignments: Record<string, string> | null | undefined,
  folder: string | null | undefined,
): T[] {
  const key = folder ? chatFolderKey(folder) : ""
  if (!key) return chats
  return chats.filter((chat) => (assignments?.[chat.id] || "").toLowerCase() === key)
}

export function chatsAvailableToSendToFolder<T extends { id: string }>(
  chats: T[],
  assignments: Record<string, string> | null | undefined,
  folder: string,
): T[] {
  const key = chatFolderKey(folder)
  if (!key) return []
  return chats.filter((chat) => Boolean(chat?.id) && (assignments?.[chat.id] || "").toLowerCase() !== key)
}

function pushUniqueFolderName(out: string[], seen: Set<string>, raw: unknown) {
  const name = normalizeChatFolderName(typeof raw === "string" ? raw : "")
  const key = name.toLowerCase()
  if (!name || seen.has(key)) return
  seen.add(key)
  out.push(name)
}

export function listChatFolderNames(
  assignments: Record<string, string> | null | undefined,
  named: readonly string[] | null | undefined = [],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of named || []) pushUniqueFolderName(out, seen, raw)
  for (const raw of Object.values(assignments || {})) pushUniqueFolderName(out, seen, raw)
  return out
}

export function parseChatFolderNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return listChatFolderNames({}, raw.filter((value) => typeof value === "string") as string[])
}

export function parseChatFolderAssignments(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const next: Record<string, string> = {}
  for (const [chatId, folder] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof chatId !== "string" || !chatId) continue
    const name = normalizeChatFolderName(typeof folder === "string" ? folder : "")
    if (!name) continue
    next[chatId] = name
  }
  return next
}

export function renameChatFolder(
  assignments: Record<string, string>,
  named: readonly string[],
  from: string,
  to: string,
): { assignments: Record<string, string>; named: string[] } {
  const current = normalizeChatFolderName(from)
  const nextName = normalizeChatFolderName(to)
  if (!current || !nextName || current.toLowerCase() === nextName.toLowerCase()) {
    return {
      assignments: { ...assignments },
      named: listChatFolderNames(assignments, named),
    }
  }
  const nextAssignments: Record<string, string> = {}
  for (const [chatId, folder] of Object.entries(assignments || {})) {
    nextAssignments[chatId] = folder.toLowerCase() === current.toLowerCase() ? nextName : folder
  }
  const nextNamed = listChatFolderNames(
    {},
    (named || []).map((folder) => (folder.toLowerCase() === current.toLowerCase() ? nextName : folder)),
  )
  return {
    assignments: nextAssignments,
    named: listChatFolderNames(nextAssignments, nextNamed),
  }
}

export function deleteChatFolder(
  assignments: Record<string, string>,
  named: readonly string[],
  name: string,
): { assignments: Record<string, string>; named: string[] } {
  const current = normalizeChatFolderName(name)
  const key = current.toLowerCase()
  const nextAssignments: Record<string, string> = {}
  for (const [chatId, folder] of Object.entries(assignments || {})) {
    if (folder.toLowerCase() === key) continue
    nextAssignments[chatId] = folder
  }
  const nextNamed = listChatFolderNames(
    {},
    (named || []).filter((folder) => folder.toLowerCase() !== key),
  )
  return {
    assignments: nextAssignments,
    named: listChatFolderNames(nextAssignments, nextNamed),
  }
}
