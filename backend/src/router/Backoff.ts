// Exponential backoff with full jitter for the multi-provider router.
//
// Companion to backend/src/utils/retry-with-backoff.js, but typed and
// dependency-free so the router can be tested in isolation under vitest.

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  rng?: () => number;
}

const DEFAULT_BASE = 250;
const DEFAULT_MAX = 30_000;
const DEFAULT_FACTOR = 2;

export class Backoff {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly factor: number;
  private readonly rng: () => number;

  constructor(opts: BackoffOptions = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX;
    this.factor = opts.factor ?? DEFAULT_FACTOR;
    this.rng = opts.rng ?? Math.random;
  }

  // Full-jitter delay = random(0, min(max, base * factor^attempt))
  // Full jitter avoids thundering herd when N callers retry the same
  // upstream in lockstep.
  delayFor(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(this.factor, Math.max(0, attempt)));
    return Math.floor(this.rng() * exp);
  }

  async sleep(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = this.delayFor(attempt);
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
