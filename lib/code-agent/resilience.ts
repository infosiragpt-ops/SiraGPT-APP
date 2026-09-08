/**
 * code-agent · resilience (pure).
 *
 * Application-layer resilience for the /code agent, kept framework-free so it
 * is testable with `node --test` like the rest of the orchestrator.
 *
 * Transport-level retries already live in lib/api.ts `generateAIStream`
 * (5 reconnect attempts with cursor resume, honor Retry-After, backoff with
 * jitter). This module adds the TWO pieces the client transport cannot cover:
 *   1. A retry/backoff policy for OpenRouter-style failures (402 / 429 / 5xx /
 *      stream timeout) that the panel can apply on top of the transport, bounded
 *      by the autonomous-iteration budget (lib/code-agent/autonomy.ts).
 *   2. A light per-model circuit breaker so a sick model (persistent 429/5xx)
 *      stops being retried for a cooldown window before the panel burns budget.
 */

/** Maximum application-layer retries ON TOP of the transport backoff. */
export const MAX_APP_RETRIES = 2
/** Base backoff delay for the first retry attempt. */
export const BASE_RETRY_DELAY_MS = 1000
/** Upper bound for the exponential backoff delay. */
export const MAX_RETRY_DELAY_MS = 15000

/** Failure classes OpenRouter surfaces on /api/ai/generate. */
export type OpenRouterFailureKind =
  | "payment_required" // 402 — quota exhausted / no valid credit
  | "rate_limit" // 429
  | "server" // 5xx
  | "timeout" // stream cut / upstream timeout, incl. GCLB 30s cut
  | "other"

export interface OpenRouterErrorLike {
  status?: number
  statusCode?: number
  code?: string
  message?: string
  name?: string
}

const RETRYABLE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504])

/** Classify a failure into an OpenRouterFailureKind for retry decisions. */
export function classifyFailure(err: OpenRouterErrorLike | null | undefined): OpenRouterFailureKind {
  if (!err) return "other"
  const status = Number(err.status ?? err.statusCode)
  const msg = String(err.message || "")
  const code = String(err.code || "")
  const name = String(err.name || "")
  const haystack = `${msg} ${code}`
  if (status === 402 || /insufficient|payment|quota|no credit|credit limit|402/i.test(haystack)) return "payment_required"
  if (status === 429 || /429|too many|rate limit|rate_limit/i.test(haystack)) return "rate_limit"
  if (status >= 500 || /5\d\d/i.test(haystack)) return "server"
  if (status === 408 || /timeout|timed out|etimedout|deadline/i.test(haystack)) return "timeout"
  if (name === "AbortError" || /abort|cancel|operation was aborted/i.test(haystack)) return "other"
  return "other"
}

/** True when the failure is worth an application-layer retry. */
export function isRetryableFailure(err: OpenRouterErrorLike | null | undefined): boolean {
  const kind = classifyFailure(err)
  return kind === "rate_limit" || kind === "server" || kind === "timeout"
}

/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped, plus up to
 * 250ms of jitter. attempt is 1-based (first retry uses base delay).
 */
export function computeBackoffMs(attempt: number, now = 0): number {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const exp = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, n - 1), MAX_RETRY_DELAY_MS)
  const jitter = now > 0 ? 0 : Math.floor(Math.random() * 250)
  return Math.min(exp + jitter, MAX_RETRY_DELAY_MS)
}

/**
 * Decide whether the panel should retry a failed stream at the application
 * layer. Bounded by `attempts < MAX_APP_RETRIES` and, when a budget is given,
 * by `!isBudgetExhausted` — a broken model can never loop forever.
 */
export function shouldRetryOpenRouter(
  err: OpenRouterErrorLike | null | undefined,
  attempts: number,
  opts?: { budgetExhausted?: boolean },
): boolean {
  if (attempts >= MAX_APP_RETRIES) return false
  if (opts?.budgetExhausted) return false
  if (!isRetryableFailure(err)) return false
  return true
}

export interface RetryWithBackoffOptions {
  /** Max application-layer retries (default MAX_APP_RETRIES). */
  maxRetries?: number
  /** Gate callback evaluated before each retry; return false to stop. */
  shouldRetry?: (err: unknown, attempt: number) => boolean
  /** Override the delay between attempts (ms). Return a number to use it. */
  delayMs?: (attempt: number) => number
  /** Called before each retry with the delay that will be applied. */
  onRetry?: (attempt: number, delayMs: number) => void
  signal?: AbortSignal
}

/**
 * Wrap `fn` with exponential-backoff retries. `fn` is expected to REJECT on a
 * retriable failure; the returned promise resolves with fn's value or rejects
 * with the last error once the budget is spent. This is the application-layer
 * retry the panel applies when the transport (lib/api.ts) has already had its
 * 5 cursor-resume attempts and still failed.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_APP_RETRIES
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) throw new Error("Request aborted")
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      if (attempt >= maxRetries) break
      if (options.shouldRetry && !options.shouldRetry(err, attempt)) break
      if (options.signal?.aborted) throw new Error("Request aborted")
      const delay = options.delayMs ? options.delayMs(attempt + 1) : computeBackoffMs(attempt + 1)
      options.onRetry?.(attempt + 1, delay)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/** Per-model circuit breaker (closed → open → half-open). */
export type BreakerState = "closed" | "open" | "half_open"

export interface CircuitBreakerConfig {
  /** Consecutive failures to trip closed → open. */
  failureThreshold: number
  /** Cooldown (ms) while open before a probe request is allowed. */
  openTimeoutMs: number
  /** Failures to re-open while half_open (a probe failure). */
  halfOpenFailThreshold?: number
}

const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  openTimeoutMs: 30_000,
  halfOpenFailThreshold: 1,
}

export class CircuitBreaker {
  readonly key: string
  state: BreakerState = "closed"
  failureCount = 0
  private openedAt = 0
  private readonly config: CircuitBreakerConfig

  constructor(key: string, config?: Partial<CircuitBreakerConfig>) {
    this.key = key
    this.config = { ...DEFAULT_BREAKER_CONFIG, ...(config || {}) }
  }

  /** True if a request to this model may proceed (and be counted). */
  allowRequest(now = Date.now()): boolean {
    if (this.state === "closed") return true
    if (this.state === "open") {
      if (now - this.openedAt >= this.config.openTimeoutMs) {
        // Cooldown elapsed → allow a single probe. A failure re-opens.
        this.state = "half_open"
        return true
      }
      return false
    }
    // half_open: allow exactly one probe.
    return true
  }

  recordSuccess(): void {
    this.failureCount = 0
    if (this.state !== "closed") {
      this.state = "closed"
      this.openedAt = 0
    }
  }

  recordFailure(now = Date.now()): boolean {
    this.failureCount++
    if (this.state === "half_open") {
      this.state = "open"
      this.openedAt = now
      return true // tripped (re-opened by probe failure)
    }
    if (this.state === "closed" && this.failureCount >= this.config.failureThreshold) {
      this.state = "open"
      this.openedAt = now
      return true // tripped
    }
    return false
  }

  reset(): void {
    this.state = "closed"
    this.failureCount = 0
    this.openedAt = 0
  }

  get isOpen(): boolean {
    return this.state === "open"
  }
}

/** Registry of per-model breakers, keyed by `${provider}:${model}`. */
export class ModelCircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>()

  get(provider: string, model: string): CircuitBreaker {
    const key = `${provider}:${model}`
    let breaker = this.breakers.get(key)
    if (!breaker) {
      breaker = new CircuitBreaker(key)
      this.breakers.set(key, breaker)
    }
    return breaker
  }

  has(provider: string, model: string): boolean {
    return this.breakers.has(`${provider}:${model}`)
  }

  resetAll(): void {
    this.breakers.clear()
  }

  get size(): number {
    return this.breakers.size
  }
}
