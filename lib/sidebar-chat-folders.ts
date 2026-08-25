export const CHAT_FOLDERS_STORAGE_KEY = "sira:chat-folders"
export const CHAT_FOLDER_NAMES_STORAGE_KEY = "sira:chat-folder-names"

export const SUGGESTED_CHAT_FOLDERS = ["Trabajo", "Empresa", "Personal"] as const

export function normalizeChatFolderName(name: string): string {
  return name.replace(/\s+/g, " ").trim()
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
