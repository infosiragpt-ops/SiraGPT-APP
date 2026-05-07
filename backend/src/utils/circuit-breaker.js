/**
 * circuit-breaker.js
 *
 * A robust Circuit Breaker for external service dependencies.
 *
 * States:
 *   CLOSED    → Normal operation. All calls pass through.
 *   OPEN      → Calls fail fast with CircuitOpenError.
 *   HALF_OPEN → Probe calls pass through; success → CLOSED, failure → OPEN.
 *
 * Features:
 *   - Rolling‑window failure counting (configurable windowMs)
 *   - Configurable threshold, cooldown, and probe count
 *   - Per‑call timeout with optional external AbortSignal
 *   - State‑change events for monitoring / logging
 *   - Metrics snapshot via toJSON()
 *   - forceState() for manual intervention or testing
 *
 * Usage:
 *   const cb = new CircuitBreaker({ name: 'stripe-api', threshold: 3 });
 *   const result = await cb.call(() => stripe.charges.create(...));
 *
 * Event monitoring:
 *   cb.on('stateChange', ({ from, to, name }) => logger.info({ from, to }, name));
 *
 * @jest-environment node
 */

'use strict';

const EventEmitter = require('node:events');

// ── Internal symbols ──────────────────────────────────────────────────────
const kState       = Symbol('state');
const kOpts        = Symbol('opts');
const kFailures    = Symbol('failures');
const kSuccesses   = Symbol('successes');
const kCallCount   = Symbol('callCount');
const kNextAttempt = Symbol('nextAttempt');
const kWindow      = Symbol('window');
const kWinMs       = Symbol('winMs');

// ── State constants ───────────────────────────────────────────────────────
const STATE = Object.freeze({
  CLOSED:   'CLOSED',
  OPEN:     'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

// ── Error types ───────────────────────────────────────────────────────────
class CircuitOpenError extends Error {
  constructor(breakerName) {
    super(`Circuit breaker "${breakerName}" is OPEN — request rejected without execution.`);
    this.name = 'CircuitOpenError';
    this.breakerName = breakerName;
  }
}

class CircuitTimeoutError extends Error {
  constructor(breakerName, timeoutMs) {
    super(`Circuit breaker "${breakerName}" timed out after ${timeoutMs}ms`);
    this.name = 'CircuitTimeoutError';
    this.breakerName = breakerName;
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  name:       'default',
  threshold:  5,          // failures within the window before opening
  cooldownMs: 30_000,     // ms before OPEN → HALF_OPEN
  probeCount: 1,          // consecutive successes in HALF_OPEN to close
  windowMs:   60_000,     // rolling failure window (0 = lifetime)
  timeoutMs:  0,          // default call timeout (0 = no timeout)
});

// ── Rolling window counter ────────────────────────────────────────────────
class RollingCounter {
  constructor(windowMs) {
    this[kWinMs] = windowMs;
    this[kWindow] = [];        // [{ t: timestamp, v: n }]
  }

  increment() {
    this._prune();
    this[kWindow].push({ t: Date.now(), v: 1 });
  }

  get count() {
    this._prune();
    return this[kWindow].reduce((s, e) => s + e.v, 0);
  }

  reset() { this[kWindow].length = 0; }

  _prune() {
    if (!this[kWinMs]) return;
    const cutoff = Date.now() - this[kWinMs];
    let i = 0;
    while (i < this[kWindow].length && this[kWindow][i].t < cutoff) i++;
    if (i > 0) this[kWindow].splice(0, i);
  }
}

// ── CircuitBreaker ────────────────────────────────────────────────────────
class CircuitBreaker extends EventEmitter {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.name='default']  - Identifier (logged / metrics)
   * @param {number}  [opts.threshold=5]      - Failures before opening
   * @param {number}  [opts.cooldownMs=30000] - ms OPEN → HALF_OPEN
   * @param {number}  [opts.probeCount=1]     - Successes in HALF_OPEN to close
   * @param {number}  [opts.windowMs=60000]   - Rolling window for failures (0 = lifetime)
   * @param {number}  [opts.timeoutMs=0]      - Default per-call timeout (0 = none)
   */
  constructor(opts = {}) {
    super();
    this.setMaxListeners(100);

    this[kOpts]   = { ...DEFAULTS, ...opts };
    this[kState]  = STATE.CLOSED;
    this[kFailures]  = new RollingCounter(this[kOpts].windowMs);
    this[kSuccesses] = new RollingCounter(0);
    this[kCallCount] = 0;
    this[kNextAttempt] = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Execute a protected async call through the circuit breaker.
   *
   * @template T
   * @param {() => Promise<T>} fn          - Async function to protect
   * @param {object}          [opts]
   * @param {number}          [opts.timeoutMs]  - Per-call timeout override
   * @param {AbortSignal}    [opts.signal]      - External abort signal
   * @returns {Promise<T>}
   * @throws {CircuitOpenError}    if circuit is OPEN
   * @throws {CircuitTimeoutError} if call exceeds timeout
   * @throws {Error}               original error from fn
   */
  async call(fn, opts = {}) {
    this[kCallCount]++;
    const state = this._resolveState();

    if (state === STATE.OPEN) {
      throw new CircuitOpenError(this[kOpts].name);
    }

    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : this[kOpts].timeoutMs;
    const externalSignal = opts.signal || null;

    let timerId;
    try {
      const result = await this._raceWithTimeout(fn, timeoutMs, externalSignal, (id) => { timerId = id; });
      this._onSuccess();
      return result;
    } catch (err) {
      if (err instanceof CircuitOpenError) throw err;
      if (err instanceof CircuitTimeoutError) {
        this._onFailure(err);
        throw err;
      }
      // External abort — don't count as a failure
      if (err && externalSignal && externalSignal.aborted) {
        throw err;
      }
      this._onFailure(err);
      throw err;
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  /**
   * Reset the breaker to CLOSED, clearing all counters.
   */
  reset() {
    const oldState = this[kState];
    this[kFailures].reset();
    this[kSuccesses].reset();
    this[kCallCount] = 0;
    this[kNextAttempt] = 0;
    this[kState] = STATE.CLOSED;
    if (oldState !== STATE.CLOSED) {
      this.emit('stateChange', {
        from: oldState,
        to: STATE.CLOSED,
        name: this[kOpts].name,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Force the breaker into a specific state (manual intervention / testing).
   */
  forceState(state) {
    if (!Object.values(STATE).includes(state)) {
      throw new TypeError(`Invalid state "${state}". Use STATE.CLOSED, STATE.OPEN, or STATE.HALF_OPEN.`);
    }
    if (state === STATE.CLOSED) return this.reset();
    this._transitionTo(state);
  }

  // ── Metrics / properties ──────────────────────────────────────────────

  get name()          { return this[kOpts].name; }
  get state()         { return this._resolveState(); }
  get failureCount()  { return this[kFailures].count; }
  get successCount()  { return this[kSuccesses].count; }
  get totalCalls()    { return this[kCallCount]; }
  get threshold()     { return this[kOpts].threshold; }
  get cooldownMs()    { return this[kOpts].cooldownMs; }
  get probeCount()    { return this[kOpts].probeCount; }
  get windowMs()      { return this[kOpts].windowMs; }
  get timeoutMs()     { return this[kOpts].timeoutMs; }

  toJSON() {
    return {
      name:              this[kOpts].name,
      state:             this.state,
      failureCount:      this.failureCount,
      successCount:      this.successCount,
      totalCalls:        this.totalCalls,
      threshold:         this[kOpts].threshold,
      cooldownMs:        this[kOpts].cooldownMs,
      probeCount:        this[kOpts].probeCount,
      windowMs:          this[kOpts].windowMs,
      timeoutMs:         this[kOpts].timeoutMs,
      cooldownRemainingMs: Math.max(0, this[kNextAttempt] - Date.now()),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /** Resolve effective state (auto-transition OPEN → HALF_OPEN when cooldown expires). */
  _resolveState() {
    if (this[kState] === STATE.OPEN && Date.now() >= this[kNextAttempt]) {
      this._transitionTo(STATE.HALF_OPEN);
    }
    return this[kState];
  }

  /** Handle a successful call — in HALF_OPEN may close the circuit. */
  _onSuccess() {
    this[kSuccesses].increment();
    if (this[kState] === STATE.HALF_OPEN && this[kSuccesses].count >= this[kOpts].probeCount) {
      this.reset();
    }
  }

  /** Handle a failed call. */
  _onFailure(err) {
    this[kFailures].increment();
    if (this[kState] === STATE.HALF_OPEN) {
      this[kSuccesses].reset();
      this._transitionTo(STATE.OPEN);
    } else if (this[kState] === STATE.CLOSED) {
      if (this[kFailures].count >= this[kOpts].threshold) {
        this._transitionTo(STATE.OPEN);
      }
    }
  }

  /** Transition to a new state, emitting event. */
  _transitionTo(newState) {
    const oldState = this[kState];
    if (oldState === newState) return;
    this[kState] = newState;

    if (newState === STATE.OPEN) {
      this[kNextAttempt] = Date.now() + this[kOpts].cooldownMs;
      this[kSuccesses].reset();
    } else if (newState === STATE.HALF_OPEN) {
      this[kSuccesses].reset();
    }

    this.emit('stateChange', {
      from: oldState,
      to: newState,
      name: this[kOpts].name,
      timestamp: Date.now(),
    });
  }

  /**
   * Race fn() against a timeout and/or external AbortSignal.
   * Returns the value of fn() or throws the first rejection.
   */
  async _raceWithTimeout(fn, timeoutMs, externalSignal, setTimerId) {
    // Fast path: no constraints
    if ((!timeoutMs || timeoutMs <= 0) && !externalSignal) {
      return fn();
    }

    const promises = [fn()];
    let timerId = null;

    // Timeout guard
    if (timeoutMs > 0) {
      promises.push(new Promise((_, reject) => {
        timerId = setTimeout(() => {
          reject(new CircuitTimeoutError(this[kOpts].name, timeoutMs));
        }, timeoutMs);
        if (setTimerId) setTimerId(timerId);
      }));
    }

    // External signal guard
    if (externalSignal) {
      promises.push(new Promise((_, reject) => {
        if (externalSignal.aborted) {
          return reject(externalSignal.reason);
        }
        externalSignal.addEventListener('abort', () => reject(externalSignal.reason), { once: true });
      }));
    }

    try {
      return await Promise.race(promises);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }
}

// ── Exports ────────────────────────────────────────────────────────────────
module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  CircuitTimeoutError,
  STATE,
};
