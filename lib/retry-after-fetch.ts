/**
 * retry-after-fetch — fetch wrapper that honors HTTP 429 / 503
 * `Retry-After` headers with bounded exponential backoff.
 *
 * Why this exists:
 *   The backend now ships a tiered rate limiter (8g) and Plan-quota
 *   gates (8h) that return 429 when a user hits a cap. The standard
 *   `RateLimit-*` and `Retry-After` response headers tell the client
 *   exactly when it's safe to retry — but our existing api.ts
 *   wrappers don't read those headers. A failed POST currently
 *   surfaces as a generic toast and the user has to click again,
 *   often at a worse moment.
 *
 *   This helper wraps a single fetch() call and, on a retryable
 *   status (429 or 503), reads `Retry-After`, waits, retries up to
 *   N times. Other statuses pass through immediately.
 *
 * Two flavors of `Retry-After` per RFC 9110:
 *   - delta-seconds: `Retry-After: 30`
 *   - HTTP-date:     `Retry-After: Fri, 31 Dec 2030 23:59:59 GMT`
 *   Both are parsed; if neither is present we fall back to
 *   exponential backoff capped by `options.maxBackoffMs`.
 *
 * What this is NOT:
 *   - Not a circuit breaker. A series of 429s eventually surfaces
 *     to the caller as the last response after `maxRetries`.
 *   - Not a queue. Concurrent calls are independent — same as fetch.
 *   - Not a global wrapper. Callers opt in per-call via
 *     `retryAfterFetch(input, init, options)`. Migrating apiClient
 *     to use it across the board is a follow-up.
 *
 * Privacy note: the helper does NOT log request bodies / URLs. It
 * only logs the wait decision via `options.onWait` (caller-provided)
 * so an analytics layer can opt into tracking how many users hit
 * 429s without leaking user data.
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

export interface RetryAfterFetchOptions {
  maxRetries?: number
  /** Base for the exponential fallback when Retry-After is absent. */
  baseBackoffMs?: number
  /** Hard cap on any single wait. Server-supplied longer waits are clamped. */
  maxBackoffMs?: number
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to setTimeout. */
  sleepFn?: (ms: number) => Promise<void>
  /** Test seam — defaults to Date.now. */
  now?: () => number
  /** Optional observer for analytics; called per wait decision. */
  onWait?: (info: { attempt: number; waitMs: number; status: number; source: 'header-seconds' | 'header-date' | 'backoff' }) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function parseRetryAfter(headerValue: string | null, now: () => number): { ms: number; source: 'header-seconds' | 'header-date' } | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  // delta-seconds: a non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { ms: seconds * 1000, source: 'header-seconds' }
    }
  }
  // HTTP-date.
  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) {
    const ms = Math.max(0, parsed - now())
    return { ms, source: 'header-date' }
  }
  return null
}

function exponentialBackoff(attempt: number, base: number, cap: number): number {
  // attempt is 1-indexed: first retry waits `base`, second `2*base`, etc.
  // Add a small jitter (±15%) so retries from many clients don't
  // synchronize into a thundering herd against the same endpoint.
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  const jitter = raw * (0.85 + Math.random() * 0.30)
  return Math.min(cap, Math.round(jitter))
}

/**
 * retryAfterFetch — single-call wrapper with Retry-After handling.
 *
 * Returns the final Response (success OR after exhausting retries).
 * Does NOT throw on retryable statuses — it retries; only network
 * errors from the underlying fetch propagate.
 */
export async function retryAfterFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryAfterFetchOptions = {},
): Promise<Response> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
  const baseBackoff = Math.max(50, options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS)
  const maxBackoff = Math.max(baseBackoff, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleepFn ?? defaultSleep
  const now = options.now ?? Date.now

  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetchImpl(input as any, init)
    lastResponse = response

    if (!RETRYABLE_STATUSES.has(response.status)) {
      return response
    }
    if (attempt === maxRetries) {
      // Out of retries — return the last 429/503 to the caller so
      // they can render the appropriate UX (the Retry-After header
      // is still readable on the response object).
      return response
    }

    const headerValue = response.headers.get('retry-after')
    const fromHeader = parseRetryAfter(headerValue, now)
    let waitMs: number
    let source: 'header-seconds' | 'header-date' | 'backoff'
    if (fromHeader) {
      waitMs = Math.min(fromHeader.ms, maxBackoff)
      source = fromHeader.source
    } else {
      waitMs = exponentialBackoff(attempt + 1, baseBackoff, maxBackoff)
      source = 'backoff'
    }

    options.onWait?.({ attempt: attempt + 1, waitMs, status: response.status, source })
    // Drain the response body before sleeping so the underlying
    // connection can be released back to the pool. Some runtimes
    // (Safari, older Node) leak sockets if the body is left
    // open across a delay.
    try { await response.body?.cancel?.() } catch (_) { /* ignore */ }
    await sleep(waitMs)
  }

  // Unreachable under normal flow — kept for type narrowing.
  return lastResponse as Response
}

export const RETRY_AFTER_FETCH_DEFAULTS = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  RETRYABLE_STATUSES,
}
