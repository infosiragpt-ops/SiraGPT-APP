/**
 * circuit-breaker — per-provider failure isolation with automatic
 * recovery probes.
 *
 * Pattern (three states):
 *   CLOSED    — healthy. Calls pass through. On failure, increment
 *               a counter; when it hits `failureThreshold`, transition
 *               to OPEN.
 *   OPEN      — provider is considered dead. Calls short-circuit with
 *               a `CircuitBreakerError` immediately (no network round-
 *               trip). After `resetTimeout` ms, transition to HALF_OPEN.
 *   HALF_OPEN — allow a single probe call through. Success → CLOSED
 *               (fully recovered). Failure → OPEN (extend the cooldown).
 *
 * Why this matters for siraGPT: when OpenAI rate-limits or Anthropic
 * throws a 5xx, every in-flight chat would otherwise hammer the
 * provider with retries, drive up latency for the user, and burn
 * budget on errors. A circuit breaker cuts that loop — one breaker
 * per (provider, model) keeps the blast radius tiny.
 *
 * Usage:
 *   const breaker = getBreaker(`openai:${model}`);
 *   return breaker.execute(() => callOpenAI(...));
 *
 * Pattern borrowed from IliaGPT's server/utils/circuitBreaker.ts;
 * rewritten in CJS JS to fit siraGPT's backend style, with an
 * `onStateChange` hook that pipes transitions into console.log so ops
 * can see provider health events in the server log.
 */

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreakerError extends Error {
  constructor(name, state, nextAttemptAt) {
    super(`Circuit breaker "${name}" is ${state}. Next attempt allowed at ${nextAttemptAt.toISOString()}`);
    this.name = 'CircuitBreakerError';
    this.breakerName = name;
    this.state = state;
    this.nextAttemptAt = nextAttemptAt;
  }
}

class CircuitBreaker {
  /**
   * @param {string} name  — stable identifier, e.g. `openai:gpt-4o`
   * @param {object} opts
   * @param {number} [opts.failureThreshold=5]  consecutive fails before OPEN
   * @param {number} [opts.resetTimeoutMs=60000] how long OPEN stays before probing
   * @param {number} [opts.halfOpenMaxCalls=1]   probe budget in HALF_OPEN
   * @param {function} [opts.onStateChange]      (from, to) => void
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
    this.halfOpenMaxCalls = opts.halfOpenMaxCalls ?? 1;
    this.onStateChange = opts.onStateChange || ((from, to) => {
      console.log(`[circuit:${this.name}] ${from} -> ${to}`);
    });

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.halfOpenCallCount = 0;
    this.halfOpenSuccessCount = 0;
    this.lastFailureAt = null;
  }

  _transition(next) {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    if (next === STATES.CLOSED) {
      this.failureCount = 0;
      this.halfOpenCallCount = 0;
      this.halfOpenSuccessCount = 0;
      this.lastFailureAt = null;
    } else if (next === STATES.HALF_OPEN) {
      this.halfOpenCallCount = 0;
      this.halfOpenSuccessCount = 0;
    }
    try { this.onStateChange(from, next); } catch { /* never let a logger break the loop */ }
  }

  _nextAttemptAt() {
    const base = this.lastFailureAt ? this.lastFailureAt.getTime() : Date.now();
    return new Date(base + this.resetTimeoutMs);
  }

  _shouldProbe() {
    if (this.state !== STATES.OPEN) return false;
    if (!this.lastFailureAt) return false;
    return Date.now() - this.lastFailureAt.getTime() >= this.resetTimeoutMs;
  }

  async execute(fn) {
    if (this.state === STATES.OPEN) {
      if (this._shouldProbe()) {
        this._transition(STATES.HALF_OPEN);
      } else {
        throw new CircuitBreakerError(this.name, this.state, this._nextAttemptAt());
      }
    }
    if (this.state === STATES.HALF_OPEN) {
      if (this.halfOpenCallCount >= this.halfOpenMaxCalls) {
        throw new CircuitBreakerError(this.name, this.state, this._nextAttemptAt());
      }
      this.halfOpenCallCount++;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.halfOpenMaxCalls) {
        this._transition(STATES.CLOSED);
      }
    } else if (this.state === STATES.CLOSED) {
      // Slow-drain prior failures so a handful of transient errors
      // across hours don't accumulate into a false-positive trip.
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  _onFailure() {
    this.failureCount++;
    this.lastFailureAt = new Date();
    if (this.state === STATES.HALF_OPEN) {
      this._transition(STATES.OPEN);
    } else if (this.state === STATES.CLOSED && this.failureCount >= this.failureThreshold) {
      this._transition(STATES.OPEN);
    }
  }

  reset() { this._transition(STATES.CLOSED); }

  stats() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureAt: this.lastFailureAt,
      nextAttemptAt: this.state === STATES.OPEN ? this._nextAttemptAt() : null,
    };
  }
}

const registry = new Map();

/** Get or lazily create a breaker by name. Same name → same instance. */
function getBreaker(name, opts) {
  let b = registry.get(name);
  if (!b) {
    b = new CircuitBreaker(name, opts);
    registry.set(name, b);
  }
  return b;
}

function allStats() {
  return Array.from(registry.values()).map(b => b.stats());
}

function resetAll() {
  for (const b of registry.values()) b.reset();
}

module.exports = { CircuitBreaker, CircuitBreakerError, getBreaker, allStats, resetAll, STATES };
