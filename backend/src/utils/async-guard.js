/**
 * async-guard — guarded async resource manager.
 *
 * Problems this solves:
 *
 *   1. "Dangling timed-out operations":
 *      Async operations that time out without cleanup may leave
 *      internal state (file handles, DB transactions, agent tool
 *      lanes) reachable and leaking. This module wraps every async
 *      operation in a guard that *guarantees* the cleanup callback
 *      runs no matter how the operation ends: success, failure,
 *      timeout, or abort.
 *
 *   2. "Resource tracked outside scope" (FinalizationRegistry):
 *      If a caller creates a guarded operation but loses the
 *      reference without calling cancel(), the GC will eventually
 *      fire the FinalizationRegistry and run the cleanup. This
 *      is a safety net — not a substitute for explicit cleanup.
 *
 *   3. "Timeout vs deadline confusion":
 *      A per-operation timeout (operation must finish in N ms) is
 *      different from a wall-clock deadline. We support both.
 *
 *   4. "Silent partial failures":
 *      Every guard enriches the error with operation metadata:
 *      guardId, elapsed, timeout, controller state, call site.
 *
 * Usage:
 *
 *   const guard = new AsyncGuard({ timeoutMs: 10_000 });
 *
 *   // Wrap an Express route handler:
 *   app.get('/data', guard.route(async (req, res) => {
 *     const result = await fetch('https://api.example.com');
 *     res.json(result);
 *   }));
 *
 *   // Guard an individual promise:
 *   const result = await guard.run(
 *     someAsyncOp(),
 *     { label: 'load-dashboard', cleanup: () => releaseConnection() }
 *   );
 *
 *   // Guard a fetch with timeout + abort:
 *   const guardedFetch = guard.fetch(fetch);
 *   const data = await guardedFetch('https://api.example.com/data');
 *
 * @module async-guard
 */

const crypto = require('crypto');
const { redactErrorLike, redactString, redactUrl } = require('./secret-redactor');

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min
const MIN_TIMEOUT_MS = 10;

// Guard states
const GUARD_PENDING = 'pending';
const GUARD_SETTLED = 'settled';
const GUARD_CANCELLED = 'cancelled';
const GUARD_TIMED_OUT = 'timed_out';

// ── Guard Error Class ────────────────────────────────────────────────────

/**
 * GuardError — thrown when a guarded operation times out or is aborted.
 * Carries structured metadata for logging and error classification.
 */
class GuardError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} [opts.code='GUARD_TIMEOUT'] - error code
   * @param {string} [opts.reason='timeout'] - machine-readable reason
   * @param {number} [opts.elapsedMs] - how long the operation ran
   * @param {number} [opts.timeoutMs] - the configured timeout
   * @param {string} [opts.label] - operation label
   * @param {string} [opts.guardId] - unique guard identifier
   * @param {Error} [opts.originalError] - wrapped original error
   */
  constructor(message, opts = {}) {
    super(redactString(message));
    this.name = 'GuardError';
    this.code = opts.code || 'GUARD_TIMEOUT';
    this.reason = opts.reason || 'timeout';
    this.elapsedMs = opts.elapsedMs;
    this.timeoutMs = opts.timeoutMs;
    this.label = opts.label ? redactString(opts.label) : null;
    this.guardId = opts.guardId || null;
    Object.defineProperty(this, 'originalError', {
      value: opts.originalError ? redactErrorLike(opts.originalError) : null,
      enumerable: false,
      configurable: true,
    });

    // Timestamps for observability
    this.timestamp = new Date().toISOString();

    // If we're wrapping an original error, copy its stack trace
    if (this.originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${redactString(this.originalError.stack)}`;
    }
  }

  /** Return a plain object for structured logging / error payloads */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      reason: this.reason,
      message: redactString(this.message),
      elapsedMs: this.elapsedMs,
      timeoutMs: this.timeoutMs,
      label: this.label ? redactString(this.label) : this.label,
      guardId: this.guardId,
      timestamp: this.timestamp,
    };
  }

  /** Return true if this error represents a transient failure that can be retried */
  isRetryable() {
    // Timeouts and aborts are often retryable if the operation is idempotent
    return this.reason === 'timeout' || this.reason === 'aborted';
  }
}

// ── Resource registration (FinalizationRegistry-based safety net) ────────

// Global registry that fires when a GuardToken is GC'd without being
// explicitly settled or cancelled. This is a safety net only — do NOT
// rely on GC timing for resource cleanup in production code paths.
const finalizationRegistry = new FinalizationRegistry(
  /**
   * @param {{ cleanup: Function, guardId: string, label: string }} held
   */
  (held) => {
    try {
      if (typeof held.cleanup === 'function') {
        held.cleanup();
      }
    } catch (_err) {
      // Swallow — GC-timed cleanup must never throw across an
      // unpredictable stack. The cleanup function is responsible
      // for its own error handling.
    }
  }
);

// ── GuardToken ───────────────────────────────────────────────────────────

/**
 * GuardToken tracks a single guarded operation. It is returned by
 * AsyncGuard#register() and passed to settle() / cancel().
 *
 * The token holds a WeakRef-style contract: if the caller loses the
 * reference and the token is GC'd, the FinalizationRegistry fires
 * the cleanup callback. This is purely a safety net for development
 * mistakes; real code must settle or cancel explicitly.
 *
 * @template T
 */
class GuardToken {
  /**
   * @param {object} opts
   * @param {string} opts.id - unique guard id
   * @param {string} [opts.label=''] - human-readable label
   * @param {AbortController} opts.controller - the associated AbortController
   * @param {number} opts.timeoutMs - timeout in ms
   * @param {number} opts.deadline - wall-clock deadline (Date.now() + timeoutMs)
   * @param {Function} [opts.cleanup] - cleanup callback (called once)
   * @param {Function} [opts.onSettle] - called when the guard settles
   */
  constructor(opts = {}) {
    this.id = opts.id;
    this.label = opts.label || '';
    this.controller = opts.controller;
    this.timeoutMs = opts.timeoutMs;
    this.deadline = opts.deadline;
    this.state = GUARD_PENDING;
    this._cleanup = typeof opts.cleanup === 'function' ? opts.cleanup : null;
    this._onSettle = typeof opts.onSettle === 'function' ? opts.onSettle : null;
    this._cleanupCalled = false;
    this.createdAt = Date.now();
    this.settledAt = null;

    // Register with FinalizationRegistry as safety net
    if (this._cleanup) {
      const held = {
        cleanup: this._cleanup,
        guardId: this.id,
        label: this.label,
      };
      finalizationRegistry.register(this, held, this);
    }
  }

  /**
   * Transition the guard to 'settled' state and run the cleanup.
   * Safe to call multiple times — only the first call has effect.
   */
  settle() {
    if (this.state !== GUARD_PENDING) return false;
    this.state = GUARD_SETTLED;
    this.settledAt = Date.now();
    this._runCleanup();
    finalizationRegistry.unregister(this);
    return true;
  }

  /**
   * Cancel the guard without settling. Runs cleanup.
   * Safe to call multiple times.
   */
  cancel() {
    if (this.state === GUARD_CANCELLED) return false;
    const wasPending = this.state === GUARD_PENDING;
    this.state = GUARD_CANCELLED;
    this.settledAt = Date.now();
    this._runCleanup();
    finalizationRegistry.unregister(this);
    if (wasPending) {
      try {
        this.controller.abort('guard cancelled');
      } catch (_err) { /* swallow */ }
    }
    return true;
  }

  /** Return elapsed ms since creation, or 0 if not created yet */
  elapsedMs() {
    if (!this.createdAt) return 0;
    return (this.settledAt || Date.now()) - this.createdAt;
  }

  /** Return remaining ms before deadline */
  remainingMs() {
    const rem = this.deadline - Date.now();
    return rem > 0 ? rem : 0;
  }

  /** True if the deadline has passed */
  isExpired() {
    return Date.now() >= this.deadline;
  }

  /** True if the AbortController has been signalled */
  get aborted() {
    return this.controller.signal.aborted;
  }

  /**
   * Return a structured metadata object for logging / error enrichment.
   */
  toMetadata() {
    return {
      guardId: this.id,
      label: this.label,
      state: this.state,
      elapsedMs: this.elapsedMs(),
      timeoutMs: this.timeoutMs,
      deadline: new Date(this.deadline).toISOString(),
      aborted: this.aborted,
      createdAt: new Date(this.createdAt).toISOString(),
    };
  }

  /** @private */
  _runCleanup() {
    if (this._cleanupCalled) return;
    this._cleanupCalled = true;
    try {
      if (typeof this._cleanup === 'function') {
        this._cleanup();
      }
      if (typeof this._onSettle === 'function') {
        this._onSettle(this);
      }
    } catch (err) {
      // Cleanup must never throw — log and continue.
      console.warn('[async-guard] cleanup threw', err?.message);
    }
  }
}

// ── AsyncGuard (public API) ──────────────────────────────────────────────

/**
 * AsyncGuard — a configurable guard for async operations.
 *
 * Creates a scoped guard that can:
 *   - Wrap individual promises with timeout + cleanup
 *   - Wrap Express route handlers
 *   - Wrap fetch calls with sanitized headers + timeout + structured errors
 *   - Track resources via GuardToken and the FinalizationRegistry
 *
 * @param {object} [options]
 * @param {number} [options.defaultTimeoutMs=30_000] - default per-operation timeout
 * @param {Function} [options.logger] - logger function (default: console.warn)
 * @param {Function} [options.errorClassifier] - (err) => { retryable, reason, ttlMs }
 */
class AsyncGuard {
  constructor(options = {}) {
    this._defaultTimeoutMs = clampInt(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    this._logger = typeof options.logger === 'function' ? options.logger : null;
    this._errorClassifier = typeof options.errorClassifier === 'function'
      ? options.errorClassifier
      : null;
  }

  /**
   * Generate a unique guard id.
   */
  _nextId() {
    return `guard_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Register a new guarded operation and return a GuardToken.
   *
   * @param {object} [opts]
   * @param {string} [opts.label=''] - human-readable label
   * @param {number} [opts.timeoutMs] - per-operation timeout (overrides default)
   * @param {Function} [opts.cleanup] - cleanup callback (called once when guard settles)
   * @returns {GuardToken}
   */
  register(opts = {}) {
    const id = this._nextId();
    const label = opts.label ? redactString(opts.label) : '';
    const timeoutMs = clampInt(
      opts.timeoutMs,
      this._defaultTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;

    // Optional metrics hook — soft-require so this module remains
    // independent of the metrics registry. If metrics.js is loaded we
    // track the live guard count via inc/dec around settle.
    let _metrics = null;
    try { _metrics = require('./metrics'); } catch { _metrics = null; }
    if (_metrics && typeof _metrics.incActiveGuards === 'function') {
      try { _metrics.incActiveGuards(); } catch { /* never throw */ }
    }

    const token = new GuardToken({
      id,
      label,
      controller,
      timeoutMs,
      deadline,
      cleanup: opts.cleanup || null,
      onSettle: () => {
        if (_metrics && typeof _metrics.decActiveGuards === 'function') {
          try { _metrics.decActiveGuards(); } catch { /* never throw */ }
        }
      },
    });

    return token;
  }

  /**
   * Run a promise under guard.
   *
   * If the promise settles (resolve/reject) before the timeout, the
   * guard is settled automatically and the result/error is returned.
   *
   * If the timeout fires first, the AbortController is aborted, the
   * guard transitions to GUARD_TIMED_OUT, and a GuardError is thrown.
   *
   * Flow for timeout:
   *   1. setTimeout fires → marks token as GUARD_TIMED_OUT, aborts controller
   *   2. raceWithSignal's signal-aware rejection fires with an AbortError
   *   3. Catch block sees `timedOut` flag → creates GuardError, runs cleanup
   *   This avoids a race between settle() and cancel() fighting over state.
   *
   * @template T
   * @param {Promise<T>} promise - the operation to guard
   * @param {object} [opts]
   * @param {string} [opts.label='']
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.cleanup]
   * @param {AbortSignal} [opts.signal] - optional external AbortSignal
   * @returns {Promise<T>}
   */
  async run(promise, opts = {}) {
    const token = this.register(opts);
    let timedOut = false;

    // Forward the signal if provided
    if (opts.signal) {
      if (opts.signal.aborted) {
        // Signal already aborted — reject immediately
        timedOut = true;
        token.state = GUARD_TIMED_OUT;
      } else {
        opts.signal.addEventListener('abort', () => {
          if (token.state === GUARD_PENDING) {
            token.state = GUARD_TIMED_OUT;
            try { token.controller.abort(opts.signal.reason || 'external abort'); } catch {}
          }
        }, { once: true });
      }
    }

    // Set up the timeout — ONLY aborts the controller and sets flag;
    // does NOT call cancel() here because the catch block below
    // handles cleanup after the promise rejection propagates.
    const timer = setTimeout(() => {
      if (token.state !== GUARD_PENDING) return;
      timedOut = true;
      token.state = GUARD_TIMED_OUT;
      token.settledAt = Date.now();
      try { token.controller.abort(new Error('guard timeout')); } catch {}
    }, token.timeoutMs);

    try {
      const result = await raceWithSignal(promise, token.controller.signal);
      token.settle();
      return result;
    } catch (err) {
      // Timeout path: create GuardError with full metadata
      if (timedOut || token.state === GUARD_TIMED_OUT) {
        token.cancel(); // runs cleanup, transitions to CANCELLED
        const elapsed = token.elapsedMs();
        const enriched = new GuardError(
          `Operation ${token.label ? `"${token.label}" ` : ''}timed out after ${elapsed}ms`,
          {
            code: 'GUARD_TIMEOUT',
            reason: 'timeout',
            elapsedMs: elapsed,
            timeoutMs: token.timeoutMs,
            label: token.label || undefined,
            guardId: token.id,
            originalError: err,
          }
        );
        throw enriched;
      }

      // Abort from external signal
      if (isAbortError(err)) {
        token.cancel(); // runs cleanup
        const elapsed = token.elapsedMs();
        const enriched = new GuardError(
          `Operation ${token.label ? `"${token.label}" ` : ''}aborted after ${elapsed}ms`,
          {
            code: 'GUARD_ABORTED',
            reason: 'aborted',
            elapsedMs: elapsed,
            timeoutMs: token.timeoutMs,
            label: token.label || undefined,
            guardId: token.id,
            originalError: err,
          }
        );
        throw enriched;
      }

      // Regular (non-abort, non-timeout) error: settle guard, attach metadata
      token.settle();
      err.guardId = token.id;
      err.guardLabel = token.label || null;
      err.guardElapsedMs = token.elapsedMs();
      throw err;
    } finally {
      clearTimeout(timer);
      // Only settle if still pending — timedOut/aborted paths
      // already handled state via cancel() above.
      if (token.state === GUARD_PENDING) {
        token.settle();
      }
    }
  }

  /**
   * Create a guard-wrapped version of the global `fetch` function.
   *
   * The wrapped fetch:
   *   1. Sanitizes headers (strips Symbol keys, validates names/values)
   *   2. Applies a per-request timeout via AbortController
   *   3. Throws GuardError on timeout, enriched with request metadata
   *   4. Isolates guard scope per-request (no shared state)
   *
   * @param {Function} [nativeFetch=globalThis.fetch] - the fetch implementation to wrap
   * @param {object} [defaults]
   * @param {number} [defaults.timeoutMs] - default per-request timeout
   * @returns {Function} guardedFetch(input, init?) → Promise<Response>
   */
  fetch(nativeFetch = globalThis.fetch, defaults = {}) {
    const guard = this;
    const defaultTimeout = defaults.timeoutMs || this._defaultTimeoutMs;

    return async function guardedFetch(input, init = {}) {
      // Sanitize headers so SDK metadata cannot make native fetch
      // reject an otherwise valid request.
      const safeInit = sanitizeFetchInit(init);

      // Apply a bounded per-request timeout while still forwarding a
      // caller-provided AbortSignal. A previous ternary treated any
      // external signal or custom timeout as `undefined`, which made
      // setTimeout fire immediately in Node and cancelled valid fetches.
      const timeout = clampInt(
        safeInit.timeout,
        defaultTimeout,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS
      );

      const inputLabel = typeof input === 'string' || input instanceof URL
        ? redactUrl(input, { maxLen: 120 })
        : 'Request';
      const token = guard.register({
        label: `fetch:${inputLabel}`,
        timeoutMs: timeout,
      });

      // Wire external signal if provided (e.g. from an upstream controller)
      const externalSignal = safeInit.signal;
      let externallyAborted = false;
      let removeExternalAbort = null;
      if (externalSignal) {
        const forwardExternalAbort = () => {
          if (token.state === GUARD_PENDING) {
            externallyAborted = true;
            try { token.controller.abort(externalSignal.reason || 'upstream abort'); } catch {}
          }
        };
        if (externalSignal.aborted) forwardExternalAbort();
        else {
          externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener('abort', forwardExternalAbort);
        }
      }

      const mergedInit = {
        ...safeInit,
        signal: token.controller.signal,
      };
      // Don't pass custom fields to native fetch
      delete mergedInit.timeout;

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        if (token.state !== GUARD_PENDING) return;
        timedOut = true;
        token.state = GUARD_TIMED_OUT;
        try { token.controller.abort(new Error('fetch timeout')); } catch {}
        // Don't cancel here — let the catch block handle cleanup
      }, timeout);

      try {
        const response = await raceWithSignal(
          nativeFetch(input, mergedInit),
          token.controller.signal
        );
        token.settle();
        return response;
      } catch (err) {
        if (timedOut || token.state === GUARD_TIMED_OUT) {
          token.cancel();
          const elapsed = token.elapsedMs();
          const enriched = new GuardError(
            `Fetch ${token.label} timed out after ${elapsed}ms`,
            {
              code: 'FETCH_TIMEOUT',
              reason: 'timeout',
              elapsedMs: elapsed,
              timeoutMs: token.timeoutMs,
              label: token.label || undefined,
              guardId: token.id,
              originalError: err,
            }
          );
          throw enriched;
        }

        if (externallyAborted || isAbortError(err)) {
          token.cancel();
          const elapsed = token.elapsedMs();
          const enriched = new GuardError(
            `Fetch ${token.label} aborted after ${elapsed}ms`,
            {
              code: 'FETCH_ABORTED',
              reason: 'aborted',
              elapsedMs: elapsed,
              timeoutMs: token.timeoutMs,
              label: token.label || undefined,
              guardId: token.id,
              originalError: err,
            }
          );
          throw enriched;
        }

        // Wrap network errors in GuardError for consistent error handling
        token.settle();
        const enriched = new GuardError(
          `Fetch ${token.label} failed: ${err.message}`,
          {
            code: 'FETCH_ERROR',
            reason: 'network-error',
            elapsedMs: token.elapsedMs(),
            timeoutMs: token.timeoutMs,
            label: token.label || undefined,
            guardId: token.id,
            originalError: err,
          }
        );
        throw enriched;
      } finally {
        clearTimeout(timeoutTimer);
        if (removeExternalAbort) removeExternalAbort();
        if (token.state === GUARD_PENDING) {
          token.settle();
        }
      }
    };
  }

  /**
   * Wrap an Express route handler (or any (req, res, next) => Promise function)
   * with a guard that catches errors, enriches them with guard metadata, and
   * forwards to next(err).
   *
   * Unlike the basic asyncHandler, this also:
   *   - Detects if the response was already sent (avoids "Cannot set headers
   *     after they are sent")
   *   - Enriches error with guard metadata for structured logging
   *   - Provides a configurable per-route timeout
   *
   * @param {Function} fn - async (req, res, next) => Promise
   * @param {object} [opts]
   * @param {string} [opts.label] - route label
   * @param {number} [opts.timeoutMs]
   * @returns {Function} Express middleware
   */
  route(fn, opts = {}) {
    const guard = this;
    const label = opts.label || fn.name || 'anonymous_route';
    return (req, res, next) => {
      const routePath = req.originalUrl || req.url || '';
      const guardOpts = {
        label: `${label}:${req.method} ${redactUrl(routePath, { maxLen: 200 })}`,
        timeoutMs: opts.timeoutMs,
      };

      guard.run(Promise.resolve().then(() => fn(req, res, next)), guardOpts)
        .catch((err) => {
          // If the response was already sent, just log and don't forward.
          if (res.headersSent || res.writableEnded) {
            const log = req.log || console;
            log.warn?.({ err, guardId: err.guardId }, 'route guard: response already sent');
            return;
          }
          next(err);
        });
    };
  }

  /**
   * Create a derived AsyncGuard with different defaults.
   * Useful for creating per-service guards with custom timeouts.
   *
   * @param {object} overrides - same options as constructor
   * @returns {AsyncGuard}
   */
  derive(overrides = {}) {
    return new AsyncGuard({
      defaultTimeoutMs: overrides.defaultTimeoutMs ?? this._defaultTimeoutMs,
      logger: overrides.logger ?? this._logger,
      errorClassifier: overrides.errorClassifier ?? this._errorClassifier,
    });
  }

  /**
   * Log via the configured logger or fallback.
   * @private
   */
  _log(...args) {
    if (this._logger) {
      this._logger(...args);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Race a promise against an AbortSignal rejection.
 *
 * When the signal fires, we reject with the signal's reason (which is
 * typically an Error or string). This mirrors the native fetch behavior
 * where an aborted fetch rejects with an AbortError.
 */
function raceWithSignal(promise, signal) {
  if (!signal || signal.aborted) {
    if (signal?.reason) return Promise.reject(signal.reason);
    return promise;
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason || new DOMException('The operation was aborted', 'AbortError');
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Determine if an error is an abort error (from AbortController or
 * various runtime implementations).
 */
function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.name === 'DOMException' && err.message?.includes?.('aborted')) return true;
  if (err instanceof DOMException && err.code === DOMException.ABORT_ERR) return true;
  if (err.code === 'ABORT_ERR') return true;
  return false;
}

/**
 * Clamp an integer between min and max.
 */
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Sanitize a fetch `init` object before passing to native fetch.
 *
 * Strips:
 *   - All Symbol-typed keys (these are metadata added by SDKs/libs and
 *     cause native fetch to throw when converting to Headers).
 *   - `null`/`undefined` values from headers (they serialize as string
 *     "null"/"undefined" when passed to Headers, which is wrong).
 *   - Non-string header values (coerces them to string).
 *
 * This keeps guarded fetch compatible with SDKs that decorate request
 * dictionaries with metadata that native fetch cannot serialize.
 */
function sanitizeFetchInit(init) {
  if (!init || typeof init !== 'object' || Array.isArray(init)) {
    return init || {};
  }

  const result = { ...init };

  // Sanitize headers
  if (result.headers != null) {
    result.headers = sanitizeHeaders(result.headers);
  }

  // Drop Symbol keys from the top-level init object
  for (const key of Object.getOwnPropertySymbols(result)) {
    delete result[key];
  }

  // Drop non-standard properties that are not valid fetch init keys
  const allowedFetchKeys = new Set([
    'method', 'headers', 'body', 'mode', 'credentials', 'cache',
    'redirect', 'referrer', 'referrerPolicy', 'integrity',
    'keepalive', 'signal', 'window', 'duplex',
    // Custom extension for our guarded fetch
    'timeout',
  ]);
  for (const key of Object.keys(result)) {
    if (!allowedFetchKeys.has(key) && !key.startsWith('_')) {
      // Allow unknown keys through — some libraries add custom props
      // that native fetch simply ignores.
    }
  }

  return result;
}

function putSanitizedHeader(target, key, value) {
  if (key == null || typeof key === 'symbol') return;
  if (value == null || typeof value === 'symbol') return;
  const name = String(key).trim();
  if (!name) return;
  target[name] = typeof value === 'string' ? value : String(value);
}

function sanitizeHeaderEntries(entries) {
  const sanitized = {};
  for (const entry of entries) {
    if (!entry || typeof entry[Symbol.iterator] !== 'function') continue;
    const pair = Array.from(entry);
    if (pair.length < 2) continue;
    putSanitizedHeader(sanitized, pair[0], pair[1]);
  }
  return sanitized;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const sanitized = {};
    headers.forEach((value, key) => putSanitizedHeader(sanitized, key, value));
    return sanitized;
  }

  if (Array.isArray(headers)) {
    return sanitizeHeaderEntries(headers);
  }

  if (typeof headers.forEach === 'function') {
    const sanitized = {};
    headers.forEach((value, key) => putSanitizedHeader(sanitized, key, value));
    return sanitized;
  }

  if (typeof headers[Symbol.iterator] === 'function') {
    return sanitizeHeaderEntries(headers);
  }

  const sanitized = {};
  for (const key of Object.getOwnPropertyNames(headers)) {
    putSanitizedHeader(sanitized, key, headers[key]);
  }
  return sanitized;
}

// ── Singleton instance ───────────────────────────────────────────────────

/**
 * Default AsyncGuard singleton with defaults.
 * Import this for most use cases; create a new instance when you need
 * a different timeout or logger.
 *
 * @type {AsyncGuard}
 */
const defaultGuard = new AsyncGuard();

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  AsyncGuard,
  GuardToken,
  GuardError,
  defaultGuard,
  // Utilities (exported for testing)
  sanitizeFetchInit,
  sanitizeHeaders,
  isAbortError,
  raceWithSignal,
  // Constants
  GUARD_PENDING,
  GUARD_SETTLED,
  GUARD_CANCELLED,
  GUARD_TIMED_OUT,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
