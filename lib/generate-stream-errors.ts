/**
 * /api/ai/generate error contract for the composer.
 *
 * Terminal (stop Pensando, no retry budget, no persist-poll):
 *   empty-body 503, JSON connection_unavailable, other 4xx except
 *   429 / 408 / retryable 409 / csrf_invalid.
 *
 * Retryable (CSRF/cookie reconnect + provider budget):
 *   429, 408, retryable 409, 5xx that is not a dead connection,
 *   first-byte transport miss (Failed to fetch), mid-stream resume
 *   with a cursor. csrf_invalid is force-refreshed once by
 *   authenticatedFetch and must not consume this budget.
 */

export const CONNECTION_UNAVAILABLE_MESSAGE = "Conexión no disponible"

type GenerateErrorDetails = {
  error?: unknown
  message?: unknown
  code?: unknown
  retryable?: unknown
} | null | undefined

function detailText(details: GenerateErrorDetails): string {
  return [details?.error, details?.message, details?.code]
    .map((value) => String(value || ""))
    .join(" ")
}

export function isConnectionUnavailablePayload(details: GenerateErrorDetails): boolean {
  return /connection_unavailable/i.test(detailText(details))
}

export function isCsrfInvalidPayload(details: GenerateErrorDetails): boolean {
  return /csrf_invalid/i.test(detailText(details))
}

export function isDeadGenerateConnection(
  status: number,
  details?: GenerateErrorDetails,
): boolean {
  if (isConnectionUnavailablePayload(details)) return true
  if (status !== 503) return false
  const payload = detailText(details).trim()
  // Live hang: 503 with responseChars=0. Treat empty/missing body as dead.
  return payload.length === 0
}

export function isGenerateHttpTerminal(
  status: number,
  details?: GenerateErrorDetails,
): boolean {
  if (!Number.isFinite(status) || status < 400) return false
  if (isDeadGenerateConnection(status, details)) return true
  if (status === 429 || status === 408) return false
  if (status === 409 && details?.retryable === true) return false
  if (isCsrfInvalidPayload(details)) return false
  if (status >= 500) return false
  return true
}

export function shouldRetryGenerateHttp(
  status: number,
  details?: GenerateErrorDetails,
  options: {
    hasDeliveredAnyContent?: boolean
    hasResumeCursor?: boolean
    attempt?: number
    maxAttempts?: number
  } = {},
): boolean {
  if (options.hasDeliveredAnyContent && !options.hasResumeCursor) return false
  if (isGenerateHttpTerminal(status, details)) return false
  if (isCsrfInvalidPayload(details)) return false
  const attempt = options.attempt ?? 1
  const maxAttempts = options.maxAttempts ?? 5
  if (attempt >= maxAttempts) return false
  return (
    status === 429
    || status === 408
    || (status === 409 && details?.retryable === true)
    || (status >= 500 && !isDeadGenerateConnection(status, details))
  )
}

export function friendlyGenerateHttpError(
  status: number,
  details?: GenerateErrorDetails,
): string {
  const payloadMessage = String(details?.message || "").trim()
  const payloadError = String(details?.error || "").trim()
  if (isConnectionUnavailablePayload(details) || status === 503) {
    if (
      payloadMessage
      && !/connection_unavailable/i.test(payloadMessage)
      && payloadMessage.length < 200
    ) {
      return payloadMessage
    }
    return CONNECTION_UNAVAILABLE_MESSAGE
  }
  const payload = payloadMessage || payloadError
  if (payload && payload.length < 240 && !/^https?:/i.test(payload)) return payload
  return `HTTP ${status}`
}

export function attachGenerateHttpError(
  status: number,
  details?: GenerateErrorDetails,
): Error & { status: number; code?: string } {
  const error = new Error(friendlyGenerateHttpError(status, details)) as Error & {
    status: number
    code?: string
  }
  error.status = status
  const code = String(details?.code || details?.error || "").trim()
  if (code) error.code = code
  return error
}
