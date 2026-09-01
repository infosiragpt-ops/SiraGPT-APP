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

  // Missing-key / fail-closed generate never persisted an assistant row.
  // Polling after 503 connection_unavailable keeps Pensando spinning.
  if (
    /connection_unavailable/i.test(text)
    || /conexión no disponible/i.test(text)
    || status === 503
  ) {
    return false
  }

  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408) {
    return false
  }

  // Safari/Cloudflare abort the fetch without aborting our Stop controller.
  // That is a transport cut, not user Stop — the backend often already
  // persisted the assistant row.
  if (error?.name === "AbortError") return true

  if (!Number.isFinite(status) || status === 0) {
    return /failed to fetch|fetch failed|network|socket|ECONN|ETIMEDOUT|520|502|incomplete|empty model stream|stream ended|stream stalled|stream connect timeout|stream_stall|internal server error/i.test(text)
  }

  return status === 408
    || status === 520
    || status === 522
    || status === 524
    || status === 502
    || status === 504
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
    const match = findPendingTurnMatch(chat?.messages, options.pending)
    if (match.hasAssistantReply) return { chat }
  }

  return null
}
