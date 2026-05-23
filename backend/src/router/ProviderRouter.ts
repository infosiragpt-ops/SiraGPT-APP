// ProviderRouter — selects the best provider for a task, retries
// transient failures with jittered exponential backoff, and falls back
// down a Policy-ranked chain when a provider trips its breaker or
// returns a hard error.
//
// Inspiration is OpenClaw's gateway routing, but the implementation is
// our own and reuses siraGPT's existing CircuitBreaker semantics
// (CLOSED / OPEN / HALF_OPEN, see backend/src/services/circuit-breaker.js).

import { Backoff } from './Backoff';
import {
  Policy,
  ProviderProfile,
  TaskRequirements,
  classifyError,
  isRetryable,
  shouldFallback,
} from './Policy';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ProviderHandler<Req, Res> {
  id: string;
  // The actual call. Implementors must respect the AbortSignal so a
  // hung upstream doesn't pin the router.
  invoke: (req: Req, ctx: { signal: AbortSignal; attempt: number }) => Promise<Res>;
}

export interface ProviderRegistration<Req, Res> {
  profile: ProviderProfile;
  handler: ProviderHandler<Req, Res>;
}

export interface BreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxCalls: number;
}

export interface RouteOptions {
  maxRetriesPerProvider?: number;
  perAttemptTimeoutMs?: number;
  signal?: AbortSignal;
  task?: TaskRequirements;
  // Override the policy for this single call without mutating the router.
  policy?: Policy;
}

export interface RouteResult<Res> {
  value: Res;
  providerId: string;
  attempts: number;
  fallbacks: number;
  totalLatencyMs: number;
}

export interface ProviderMetrics {
  providerId: string;
  requests: number;
  successes: number;
  failures: number;
  fallbacksFrom: number; // times we fell off this provider to the next
  totalLatencyMs: number;
  errorsByClass: Record<string, number>;
  circuit: { state: CircuitState; failureCount: number; openedAt: number | null };
}

interface InternalBreaker {
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  halfOpenInFlight: number;
}

export class CircuitOpenError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Circuit open for provider "${providerId}"`);
    this.name = 'CircuitOpenError';
    this.providerId = providerId;
  }
}

export class NoProviderAvailableError extends Error {
  readonly causes: Array<{ providerId: string; error: unknown }>;
  constructor(causes: Array<{ providerId: string; error: unknown }>) {
    super(`No provider available (${causes.length} candidate(s) exhausted)`);
    this.name = 'NoProviderAvailableError';
    this.causes = causes;
  }
}

const DEFAULT_BREAKER: BreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
};

export class ProviderRouter<Req, Res> {
  private readonly registry = new Map<string, ProviderRegistration<Req, Res>>();
  private readonly breakers = new Map<string, InternalBreaker>();
  private readonly metrics = new Map<string, ProviderMetrics>();
  private readonly backoff: Backoff;
  private readonly breakerOpts: BreakerOptions;
  private readonly clock: () => number;
  private policy: Policy;

  constructor(opts: {
    policy?: Policy;
    backoff?: Backoff;
    breaker?: Partial<BreakerOptions>;
    clock?: () => number;
  } = {}) {
    this.policy = opts.policy ?? Policy.fromEnv();
    this.backoff = opts.backoff ?? new Backoff();
    this.breakerOpts = { ...DEFAULT_BREAKER, ...(opts.breaker ?? {}) };
    this.clock = opts.clock ?? Date.now;
  }

  register(reg: ProviderRegistration<Req, Res>): this {
    this.registry.set(reg.profile.id, reg);
    this.breakers.set(reg.profile.id, {
      state: 'CLOSED',
      failureCount: 0,
      openedAt: null,
      halfOpenInFlight: 0,
    });
    this.metrics.set(reg.profile.id, {
      providerId: reg.profile.id,
      requests: 0,
      successes: 0,
      failures: 0,
      fallbacksFrom: 0,
      totalLatencyMs: 0,
      errorsByClass: {},
      circuit: { state: 'CLOSED', failureCount: 0, openedAt: null },
    });
    return this;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  getCircuitState(providerId: string): CircuitState | null {
    return this.breakers.get(providerId)?.state ?? null;
  }

  getMetrics(): ProviderMetrics[] {
    return Array.from(this.metrics.values()).map(m => ({
      ...m,
      errorsByClass: { ...m.errorsByClass },
      circuit: { ...m.circuit },
    }));
  }

  async route(req: Req, opts: RouteOptions = {}): Promise<RouteResult<Res>> {
    const policy = opts.policy ?? this.policy;
    const profiles: ProviderProfile[] = [];
    for (const reg of this.registry.values()) profiles.push(reg.profile);
    const ordered = policy.rank(profiles, opts.task ?? {});

    const causes: Array<{ providerId: string; error: unknown }> = [];
    const start = this.clock();
    let totalAttempts = 0;
    let fallbacks = 0;

    for (let i = 0; i < ordered.length; i++) {
      const providerId = ordered[i];
      const reg = this.registry.get(providerId);
      if (!reg) continue;

      if (!this.canAttempt(providerId)) {
        causes.push({ providerId, error: new CircuitOpenError(providerId) });
        continue;
      }

      const maxRetries = opts.maxRetriesPerProvider ?? 2;
      let lastErr: unknown = undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (opts.signal?.aborted) {
          throw new Error('aborted');
        }
        totalAttempts++;
        const onEnter = this.beforeAttempt(providerId);
        const attemptStart = this.clock();
        try {
          const value = await this.invokeWithTimeout(reg.handler, req, {
            attempt,
            externalSignal: opts.signal,
            timeoutMs: opts.perAttemptTimeoutMs,
          });
          this.recordSuccess(providerId, this.clock() - attemptStart, onEnter);
          return {
            value,
            providerId,
            attempts: totalAttempts,
            fallbacks,
            totalLatencyMs: this.clock() - start,
          };
        } catch (err) {
          lastErr = err;
          const cls = classifyError(err);
          this.recordFailure(providerId, this.clock() - attemptStart, cls, onEnter);

          // Retry budget on transient classes; otherwise break to fallback.
          if (attempt < maxRetries && isRetryable(cls) && !opts.signal?.aborted) {
            try {
              await this.backoff.sleep(attempt + 1, opts.signal);
            } catch {
              throw new Error('aborted');
            }
            continue;
          }

          if (!shouldFallback(cls)) {
            // Unknown / non-fallback error — surface it directly.
            throw err;
          }
          break;
        }
      }

      causes.push({ providerId, error: lastErr });
      const m = this.metrics.get(providerId);
      if (m) m.fallbacksFrom++;
      fallbacks++;
    }

    throw new NoProviderAvailableError(causes);
  }

  // ── internals ────────────────────────────────────────────────

  private canAttempt(providerId: string): boolean {
    const b = this.breakers.get(providerId);
    if (!b) return false;
    if (b.state === 'CLOSED') return true;
    if (b.state === 'OPEN') {
      if (b.openedAt != null && this.clock() - b.openedAt >= this.breakerOpts.resetTimeoutMs) {
        b.state = 'HALF_OPEN';
        b.halfOpenInFlight = 0;
        this.syncCircuitToMetrics(providerId);
        return b.halfOpenInFlight < this.breakerOpts.halfOpenMaxCalls;
      }
      return false;
    }
    // HALF_OPEN: cap probes
    return b.halfOpenInFlight < this.breakerOpts.halfOpenMaxCalls;
  }

  private beforeAttempt(providerId: string): { wasHalfOpen: boolean } {
    const b = this.breakers.get(providerId)!;
    const m = this.metrics.get(providerId)!;
    m.requests++;
    if (b.state === 'HALF_OPEN') {
      b.halfOpenInFlight++;
      return { wasHalfOpen: true };
    }
    return { wasHalfOpen: false };
  }

  private recordSuccess(providerId: string, latencyMs: number, ctx: { wasHalfOpen: boolean }): void {
    const b = this.breakers.get(providerId)!;
    const m = this.metrics.get(providerId)!;
    m.successes++;
    m.totalLatencyMs += latencyMs;
    if (ctx.wasHalfOpen) b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
    // Success closes the circuit and slow-drains residual failures so
    // a transient blip can't accumulate into a false-positive trip.
    b.state = 'CLOSED';
    b.failureCount = Math.max(0, b.failureCount - 1);
    b.openedAt = null;
    this.syncCircuitToMetrics(providerId);
  }

  private recordFailure(
    providerId: string,
    latencyMs: number,
    cls: string,
    ctx: { wasHalfOpen: boolean },
  ): void {
    const b = this.breakers.get(providerId)!;
    const m = this.metrics.get(providerId)!;
    m.failures++;
    m.totalLatencyMs += latencyMs;
    m.errorsByClass[cls] = (m.errorsByClass[cls] ?? 0) + 1;
    if (ctx.wasHalfOpen) {
      b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
      // A failed probe re-opens the circuit and extends cooldown.
      b.state = 'OPEN';
      b.openedAt = this.clock();
    } else {
      b.failureCount++;
      if (b.state === 'CLOSED' && b.failureCount >= this.breakerOpts.failureThreshold) {
        b.state = 'OPEN';
        b.openedAt = this.clock();
      }
    }
    this.syncCircuitToMetrics(providerId);
  }

  private syncCircuitToMetrics(providerId: string): void {
    const b = this.breakers.get(providerId);
    const m = this.metrics.get(providerId);
    if (!b || !m) return;
    m.circuit.state = b.state;
    m.circuit.failureCount = b.failureCount;
    m.circuit.openedAt = b.openedAt;
  }

  private async invokeWithTimeout(
    handler: ProviderHandler<Req, Res>,
    req: Req,
    opts: { attempt: number; externalSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<Res> {
    const ac = new AbortController();
    const onAbort = () => ac.abort(opts.externalSignal?.reason);
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort(opts.externalSignal.reason);
      else opts.externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = new Error(`Provider "${handler.id}" timed out after ${opts.timeoutMs}ms`);
        (e as Error & { name: string }).name = 'TimeoutError';
        ac.abort(e);
      }, opts.timeoutMs);
    }
    try {
      return await handler.invoke(req, { signal: ac.signal, attempt: opts.attempt });
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.externalSignal) opts.externalSignal.removeEventListener('abort', onAbort);
    }
  }
}
