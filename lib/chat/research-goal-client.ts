export type ResearchGoalPointer = { runId: string; chatId: string; ownerId: string }
export type ResearchGoalStatus = {
  runId: string
  chatId: string
  status: "running" | "completed" | "cancelled" | "failed"
  result?: { report?: string; stats?: { papersFound?: number; findingsExtracted?: number } }
  error?: string
}

const validRunId = (value: unknown): value is string => typeof value === "string" && /^rr_[a-zA-Z0-9_-]{1,76}$/.test(value)
const pointerKey = (ownerId: string, chatId: string) => `siragpt:research-goal:v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(chatId)}`
function storage() { try { return typeof window !== "undefined" ? window.localStorage : null } catch { return null } }

export function saveResearchGoalPointer(pointer: ResearchGoalPointer) {
  if (!pointer.ownerId || !pointer.chatId || !validRunId(pointer.runId)) return
  try { storage()?.setItem(pointerKey(pointer.ownerId, pointer.chatId), JSON.stringify(pointer)) } catch { /* user-message metadata is the durable fallback */ }
}
export function clearResearchGoalPointer(pointer: ResearchGoalPointer) {
  try {
    const key = pointerKey(pointer.ownerId, pointer.chatId)
    const current = storage()?.getItem(key)
    if (current && JSON.parse(current)?.runId === pointer.runId) storage()?.removeItem(key)
  } catch { /* no browser storage */ }
}
function metadata(message: any): any {
  try { return typeof message?.metadata === "string" ? JSON.parse(message.metadata) : message?.metadata || {} } catch { return {} }
}
/** Recover by owner+chat, even if storage is disabled; never revive a finished report. */
export function findResearchGoalPointer(ownerId: string, chat: { id?: string; messages?: any[] } | null | undefined): ResearchGoalPointer | null {
  if (!ownerId || !chat?.id || chat.id.startsWith("temp-chat-")) return null
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const completed = new Set(messages.filter(message => String(message?.role).toUpperCase() === "ASSISTANT")
    .map(message => metadata(message).researchRunId).filter(validRunId))
  try {
    const raw = storage()?.getItem(pointerKey(ownerId, chat.id))
    const saved = raw ? JSON.parse(raw) : null
    if (saved?.ownerId === ownerId && saved?.chatId === chat.id && validRunId(saved.runId) && !completed.has(saved.runId)) return saved
  } catch { /* use persisted message metadata */ }
  for (const message of [...messages].reverse()) {
    const runId = metadata(message).researchRunId
    if (String(message?.role).toUpperCase() === "USER" && validRunId(runId) && !completed.has(runId)) return { runId, chatId: chat.id, ownerId }
  }
  return null
}

/** Chunk-safe SSE decoder, including CRLF and a final frame without a blank line. */
export function createResearchEventDecoder(onEvent: (event: any) => void) {
  const decoder = new TextDecoder()
  let buffer = ""
  const frame = (value: string) => {
    const data = value.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
    if (!data) return
    try { onEvent(JSON.parse(data)) } catch { /* malformed frame cannot discard later events */ }
  }
  return {
    push(chunk?: Uint8Array, done = false) {
      buffer += decoder.decode(chunk, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ""
      frames.forEach(frame)
      if (done && buffer.trim()) { frame(buffer); buffer = "" }
    },
  }
}
