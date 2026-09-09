import { findPendingTurnMatch, type PendingMessage } from "./pending-messages"

type RecoverError = {
  name?: string
  message?: string
  code?: string
  status?: number
  statusCode?: number
  acceptanceFailure?: boolean
}

const ACCEPTANCE_FAILURE_MESSAGE = 'La prueba no puede continuar con el presupuesto acreditado. Revisa la campaña de pruebas.'
export type PersistedTurnFailure = {
  code: 'E_QUOTA'
  message: string
  terminal: true
  retryable: false
  acceptanceFailure: true
}
export type PersistedTurnRecovery = { chat: any; failure?: PersistedTurnFailure }

export function acceptanceTurnFailure(): PersistedTurnFailure {
  // Closed vocabulary: never expose a stored provider message or internal cause.
  return { code: 'E_QUOTA', message: ACCEPTANCE_FAILURE_MESSAGE, terminal: true, retryable: false, acceptanceFailure: true }
}

export function persistedTurnFailureError(_failure: PersistedTurnFailure): Error {
  return Object.assign(new Error(ACCEPTANCE_FAILURE_MESSAGE), acceptanceTurnFailure())
}

export function resolvePersistedAssistantTurn(
  chat: any,
  pending: Pick<PendingMessage, 'idempotencyKey' | 'turnKey' | 'streamId'>,
): PersistedTurnRecovery | null {
  const match = findPendingTurnMatch(chat?.messages, pending)
  if (!match.hasAssistantReply) return null
  const assistant = chat.messages[match.assistantIndex]
  let metadata = assistant.metadata
  try { if (typeof metadata === 'string') metadata = JSON.parse(metadata) } catch { metadata = null }
  const storedFailure = metadata?.acceptanceFailure
  if (storedFailure?.code !== 'E_QUOTA' || storedFailure.status !== 'failed' || storedFailure.terminal !== true) {
    return { chat }
  }
  const failure = acceptanceTurnFailure()
  return { failure, chat: { ...chat, messages: chat.messages.map((message: any, index: number) => (
    // ErrorMessage replaces the entire bubble. Keep the partial and the
    // server's failure notice visible; metadata/background state carry failure.
    index === match.assistantIndex ? { ...message, error: undefined } : message
  )) } }
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
  if (error?.acceptanceFailure === true && error.code === 'E_QUOTA') return false

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
    // The friendly copy generateAIStream emits once its reconnect budget is
    // spent must still poll: the backend keeps running detached and has
    // usually persisted the reply by then.
    return /failed to fetch|fetch failed|network|socket|ECONN|ETIMEDOUT|520|502|incomplete|empty model stream|stream ended|stream stalled|stream connect timeout|stream_stall|internal server error|no se pudo conectar con el modelo|no se pudo completar la respuesta|terminó antes de completar/i.test(text)
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
}): Promise<PersistedTurnRecovery | null> {
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
    if (options.isCancelled?.()) return null

    const chat = response?.chat || response
    const recovered = resolvePersistedAssistantTurn(chat, options.pending)
    if (recovered) return recovered
  }

  return null
}
