/**
 * /api/ai/generate error contract for the composer.
 *
 * Terminal (stop Pensando, no retry budget, no persist-poll):
 *   empty-body 503, JSON connection_unavailable, JSON provider_unavailable,
 *   429 quota_exceeded (the user's plan), any `retryable: false`, and other
 *   4xx except 429 / 408 / retryable 409 / csrf_invalid.
 *
 * Retryable (CSRF/cookie reconnect + provider budget):
 *   429 rate limits, 408, retryable 409, 5xx that is not a dead connection,
 *   first-byte transport miss (Failed to fetch), mid-stream resume
 *   with a cursor. csrf_invalid is force-refreshed once by
 *   authenticatedFetch and must not consume this budget.
 *
 * The kind of every failure (and its Spanish copy) comes from
 * lib/generate-retry-policy.ts; this module keeps the HTTP-shaped helpers.
 */

import {
  CONNECTION_UNAVAILABLE_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
  classifyGenerateFailure,
  type GenerateFailureDecision,
  type GenerateFailureKind,
} from "./generate-retry-policy"

export { CONNECTION_UNAVAILABLE_MESSAGE, PROVIDER_UNAVAILABLE_MESSAGE }

type GenerateErrorDetails = {
  error?: unknown
  message?: unknown
  code?: unknown
  retryable?: unknown
  upgradeRequired?: unknown
} | null | undefined

function detailText(details: GenerateErrorDetails): string {
  return [details?.error, details?.message, details?.code]
    .map((value) => String(value || ""))
    .join(" ")
}

export function isConnectionUnavailablePayload(details: GenerateErrorDetails): boolean {
  return /connection_unavailable/i.test(detailText(details))
}

export function isProviderUnavailablePayload(details: GenerateErrorDetails): boolean {
  return /provider_unavailable|PROVIDER_CONNECTION_UNAVAILABLE/i.test(detailText(details))
}

export function isCsrfInvalidPayload(details: GenerateErrorDetails): boolean {
  return /csrf_invalid/i.test(detailText(details))
}

export function isDeadGenerateConnection(
  status: number,
  details?: GenerateErrorDetails,
): boolean {
  if (isConnectionUnavailablePayload(details)) return true
  if (isProviderUnavailablePayload(details)) return true
  if (status !== 503) return false
  const payload = detailText(details).trim()
  // Live hang: 503 with responseChars=0. Treat empty/missing body as dead.
  return payload.length === 0
}

/** Policy decision for one HTTP failure of /api/ai/generate. */
export function classifyGenerateHttpFailure(
  status: number,
  details?: GenerateErrorDetails,
  retryAfterMs?: number | null,
): GenerateFailureDecision {
  return classifyGenerateFailure({
    status,
    code: details?.code,
    error: details?.error,
    message: details?.message,
    retryable: details?.retryable,
    retryAfterMs: retryAfterMs ?? null,
    upgradeRequired: details?.upgradeRequired,
  })
}

export function isGenerateHttpTerminal(
  status: number,
  details?: GenerateErrorDetails,
): boolean {
  if (!Number.isFinite(status) || status < 400) return false
  if (isDeadGenerateConnection(status, details)) return true
  if (isCsrfInvalidPayload(details)) return false
  return !classifyGenerateHttpFailure(status, details).retryable
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
  return classifyGenerateHttpFailure(status, details).retryable
}

/**
 * Spanish copy for one HTTP failure. Never a bare «HTTP nnn»: a 502/504/52x
 * reads as a SiraGPT update, raw codes become Spanish, and a human server
 * message (e.g. «DeepSeek V4 Pro no pudo responder: …») is kept verbatim.
 */
export function friendlyGenerateHttpError(
  status: number,
  details?: GenerateErrorDetails,
): string {
  return classifyGenerateHttpFailure(status, details).userMessage
}

export type GenerateHttpError = Error & {
  status: number
  code?: string
  kind: GenerateFailureKind
  retryable: boolean
  retryAfterMs: number | null
  errorData?: unknown
}

export function attachGenerateHttpError(
  status: number,
  details?: GenerateErrorDetails,
  retryAfterMs?: number | null,
): GenerateHttpError {
  const decision = classifyGenerateHttpFailure(status, details, retryAfterMs)
  const error = new Error(decision.userMessage) as GenerateHttpError
  error.status = status
  const code = String(details?.code || details?.error || "").trim()
  if (code) error.code = code
  error.kind = decision.kind
  error.retryable = decision.retryable
  error.retryAfterMs = decision.retryAfterMs
  if (details && typeof details === "object") error.errorData = details
  return error
}
