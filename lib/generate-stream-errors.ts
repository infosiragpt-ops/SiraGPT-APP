/**
 * /api/ai/generate error contract for the composer.
 *
 * A non-SSE 4xx/5xx (especially 503 connection_unavailable), a network
 * abort, or a JSON error must stop Pensando immediately. Missing provider
 * keys are terminal — retrying them looks like an infinite spinner.
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

export function isGenerateHttpTerminal(
  status: number,
  details?: GenerateErrorDetails,
): boolean {
  if (!Number.isFinite(status) || status < 400) return false
  if (isConnectionUnavailablePayload(details)) return true
  if (status === 429) return false
  if (status === 409 && details?.retryable === true) return false
  return true
}

export function shouldRetryGenerateHttp(
  status: number,
  details?: GenerateErrorDetails,
  options: { hasDeliveredAnyContent?: boolean; attempt?: number; maxAttempts?: number } = {},
): boolean {
  if (options.hasDeliveredAnyContent) return false
  if (isGenerateHttpTerminal(status, details)) return false
  const attempt = options.attempt ?? 1
  const maxAttempts = options.maxAttempts ?? 5
  if (attempt >= maxAttempts) return false
  return status === 429 || (status === 409 && details?.retryable === true)
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
