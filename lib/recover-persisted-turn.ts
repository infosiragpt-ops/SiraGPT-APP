import { findPendingTurnMatch, type PendingMessage } from "./pending-messages"

type RecoverError = {
  name?: string
  message?: string
  code?: string
  status?: number
  statusCode?: number
}

export function isExplicitUserStop(
  signal?: AbortSignal | null,
  userStopped?: boolean,
): boolean {
  return Boolean(userStopped || signal?.aborted)
}

export function shouldRecoverPersistedGenerate(
  error: RecoverError | null | undefined,
  options: { signal?: AbortSignal | null; userStopped?: boolean } = {},
): boolean {
  if (isExplicitUserStop(options.signal, options.userStopped)) return false

  const status = Number(error?.status ?? error?.statusCode)
  const text = [error?.message, error?.name, error?.code].filter(Boolean).join(" ")

  // Safari/Cloudflare abort the fetch without aborting our Stop controller.
  // That is a transport cut, not user Stop — the backend often already
  // persisted the assistant row.
  if (error?.name === "AbortError") return true

  if (!Number.isFinite(status) || status === 0) {
    return /failed to fetch|fetch failed|network|socket|ECONN|ETIMEDOUT|520|502|incomplete|empty model stream|stream ended|internal server error/i.test(text)
  }

  return status === 408
    || status === 520
    || status === 522
    || status === 524
    || (status >= 500 && status <= 599)
}

export async function pollPersistedAssistantTurn(options: {
  getChat: (chatId: string) => Promise<any>
  chatId: string
  pending: Pick<PendingMessage, "idempotencyKey" | "turnKey" | "streamId">
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  isCancelled?: () => boolean
}): Promise<{ chat: any } | null> {
  const attempts = Math.max(1, options.attempts ?? 8)
  const delayMs = Math.max(0, options.delayMs ?? 750)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isCancelled?.()) return null
    if (attempt > 0 && delayMs > 0) await sleep(delayMs)
    if (options.isCancelled?.()) return null

    let response: any
    try {
      response = await options.getChat(options.chatId)
    } catch {
      continue
    }

    const chat = response?.chat || response
    if (extractPersistedAssistantContent(chat, options.pending)) return { chat }
  }

  return null
}

function messageContent(message: { content?: unknown } | null | undefined): string | null {
  const content = message?.content
  if (typeof content !== "string") return null
  const trimmed = content.trim()
  return trimmed ? content : null
}

/**
 * Prefer the assistant row that shares this turn's idempotency key.
 * Fall back to the last non-empty assistant after the matching user
 * message so a replay whose metadata has not landed yet still paints.
 */
export function extractPersistedAssistantContent(
  chat: { messages?: Array<{ role?: unknown; content?: unknown; metadata?: unknown }> } | null | undefined,
  pending?: Pick<PendingMessage, "idempotencyKey" | "turnKey" | "streamId"> | null,
): string | null {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  if (messages.length === 0) return null

  if (pending) {
    const match = findPendingTurnMatch(messages, pending)
    if (match.hasAssistantReply) {
      return messageContent(messages[match.assistantIndex])
    }
    if (match.userIndex >= 0) {
      for (let index = messages.length - 1; index > match.userIndex; index -= 1) {
        if (String(messages[index]?.role || "").toUpperCase() !== "ASSISTANT") continue
        const content = messageContent(messages[index])
        if (content) return content
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role || "").toUpperCase() !== "ASSISTANT") continue
    const content = messageContent(messages[index])
    if (content) return content
  }
  return null
}
