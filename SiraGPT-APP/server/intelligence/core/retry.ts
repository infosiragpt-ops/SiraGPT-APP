/**
 * server/intelligence/core/retry.ts
 *
 * Retry-with-exponential-backoff + jitter, per-attempt timeout, and a small
 * "try the next candidate" cascade helper used by the orchestrator to walk a
 * model fallback chain with graceful degradation.
 *
 * Mirrors the backend's reliability conventions (transient-only retries) but is
 * self-contained and pure so it can be unit-tested deterministically with an
 * injected clock / sleeper.
 */

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** Decide whether an error is worth retrying (default: everything). */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injected sleep (tests pass a no-op / fake timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected RNG in [0,1) for jitter (tests pass a constant). */
  readonly random?: () => number;
  /** Optional hook fired before each retry. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: delay = random(0, min(maxMs, base*2^n)). */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    baseMs,
    maxMs,
    isRetryable = () => true,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= maxRetries || !isRetryable(e)) break;
      const delay = backoffDelay(attempt, baseMs, maxMs, random);
      if (onRetry) onRetry(attempt + 1, delay, e);
      await sleep(delay);
    }
  }
  throw lastError;
}

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise-returning fn against a timeout, aborting via the signal. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Try an ordered list of candidates, moving to the next on failure. Returns the
 * first success along with the candidate that produced it; throws the last
 * error if every candidate fails. This is the graceful-degradation primitive
 * behind the router's primary → fallbacks chain.
 */
export async function cascade<C, T>(
  candidates: ReadonlyArray<C>,
  run: (candidate: C, index: number) => Promise<T>,
  options?: {
    readonly isRetryable?: (error: unknown) => boolean;
    readonly onFallback?: (from: C, to: C, error: unknown) => void;
  }
): Promise<{ value: T; candidate: C; index: number; fellBack: boolean }> {
  if (candidates.length === 0) {
    throw new Error('cascade: no candidates provided');
  }
  const isRetryable = options?.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const value = await run(candidates[i], i);
      return { value, candidate: candidates[i], index: i, fellBack: i > 0 };
    } catch (e) {
      lastError = e;
      const hasNext = i < candidates.length - 1;
      if (!hasNext || !isRetryable(e)) {
        if (!hasNext) break;
        if (!isRetryable(e)) break;
      }
      if (hasNext && options?.onFallback) {
        options.onFallback(candidates[i], candidates[i + 1], e);
      }
    }
  }
  throw lastError;
}
