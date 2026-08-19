/**
 * fetch-instrument — instrumented fetch with OTel tracing, logging,
 * timeout enforcement, and header sanitization.
 *
 * Provides:
 *   - `FetchInstrument` class: install() patches globalThis.fetch;
 *     uninstall() restores. Every outgoing HTTP call gets a tracing
 *     span, structured log, timeout guard, and sanitised headers.
 *   - `instrumentedFetch(url, init?, options?)` — standalone wrapped
 *     fetch without touching the global.
 *   - `createFetch(options?)` — factory for a one-off instrumented fetch.
 *
 * The wrapper reuses sanitizeFetchInit (from async-guard) to strip
 * request metadata that native fetch cannot serialize.
 *
 * @module fetch-instrument
 */

'use strict';

const { trace, context, SpanStatusCode, propagation } = require('@opentelemetry/api');
const pino = require('pino');
const { redactString, redactUrl } = require('./secret-redactor');

// ── Peer dependency: async-guard ───────────────────────────────────────────
// We import from async-guard to reuse sanitiseFetchInit.  In a real
// application the path would be relative or resolved by the module
// system.  If the import fails during testing (when async-guard is not
// available) we fall back to a basic sanitizer.
let sanitizeFetchInit;
try {
  sanitizeFetchInit = require('./async-guard').sanitizeFetchInit;
} catch {
  // Fallback: strip Symbol keys/values from a plain header object.
  sanitizeFetchInit = (init) => {
    if (!init) return {};
    const { headers, ...rest } = init;
    if (!headers || headers instanceof Headers) return init;
    if (typeof headers.forEach === 'function') return init;
    const safe = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k === 'symbol') continue;
      if (v == null) continue;
      if (typeof v === 'symbol') continue;
      safe[k] = String(v);
    }
    return { ...rest, headers: safe };
  };
}

// ── Private symbols ────────────────────────────────────────────────────────
const kOriginalFetch  = Symbol('fetch-instrument.original');
const kIsPatched      = Symbol('fetch-instrument.patched');
const kOptions        = Symbol('fetch-instrument.options');
const kActiveCount    = Symbol('fetch-instrument.active');
const kTotalCount     = Symbol('fetch-instrument.total');
const kErrorCount     = Symbol('fetch-instrument.errors');
const kTimeoutCount   = Symbol('fetch-instrument.timeouts');
const kMaxLatency     = Symbol('fetch-instrument.maxLatency');
const kMinLatency     = Symbol('fetch-instrument.minLatency');
const kSumLatency     = Symbol('fetch-instrument.sumLatency');
const kInstalled      = Symbol('fetch-instrument.installed');

// ── Defaults ───────────────────────────────────────────────────────────────
const DEFAULT_OPTIONS = Object.freeze({
  /** Timeout (ms) applied to every outgoing request. 0 = no timeout. */
  timeoutMs: 30_000,
  /** Logger instance.  When falsy a no-op pino child is used. */
  logger: null,
  /** OTel tracer name.  The module-level tracer is lazy-initialised. */
  tracerName: '@siragpt/fetch-instrument',
  /** Minimum URL length in log messages. Longer URLs are truncated. */
  logUrlMaxLength: 200,
  /** Emit a log line for every request (level = 'info' for success, 'warn' for error). */
  logRequests: true,
  /** Mark response body bytes in the span (may increase memory). */
  recordBodySize: false,
  /**
   * HTTP status codes considered "ok". Codes outside this set produce
   * a span with status=error and a warning log.
   */
  successStatuses: [200, 201, 202, 203, 204, 205, 206, 304],
});

// ── Id generator (crypto-based) ────────────────────────────────────────────
let _idCounter = 0n;

function nextRequestId() {
  // Short unique id: epoch ms (base-36) + counter (base-36) + random nibble
  const ts = Date.now().toString(36);
  const seq = (++_idCounter).toString(36);
  const rnd = Math.random().toString(36).slice(2, 5);
  return `fetch_${ts}_${seq}_${rnd}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return a structured attrs object for the span. */
function spanAttrs(method, url, status, elapsedMs, contentLength) {
  const attrs = {
    'http.method': method || 'GET',
    'http.url': redactUrl(url, { maxLen: 500 }),
    'http.status_code': status ?? 0,
    'fetch.duration_ms': elapsedMs,
  };
  if (contentLength != null) attrs['http.response_content_length'] = contentLength;
  return attrs;
}

/** Safely read Content-Length from Response headers. */
function contentLength(res) {
  if (!res) return undefined;
  const v = res.headers?.get ? res.headers.get('content-length') : undefined;
  return v ? Number(v) : undefined;
}

/** Redact and truncate a URL for logging. */
function logUrl(url, maxLen) {
  return redactUrl(url, { maxLen });
}

/** Check if a status code falls within the success range. */
function isSuccessStatus(code, list) {
  return list.length === 0 ? (code >= 200 && code < 400) : list.includes(code);
}

// ── Tracer (lazy) ──────────────────────────────────────────────────────────
function resolveTracer(name) {
  try {
    return trace.getTracer(name);
  } catch {
    return null;
  }
}

// ── Default logger (no-op) ─────────────────────────────────────────────────
function noopLogger() {
  return pino({ enabled: false });
}

// ── raceWithSignal — local helper ──────────────────────────────────────────
// Wraps a promise so it rejects when the AbortSignal fires, even if the
// original promise ignores the signal (e.g. a mock fetch that never checks
// the AbortController).
function raceWithSignal(promise, signal) {
  if (!signal || signal.aborted) {
    if (signal?.reason) return Promise.reject(signal.reason);
    return promise;
  }

  let onAbort;
  const race = new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason || new Error('The operation was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const cleanup = () => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  };

  return Promise.race([
    promise.finally(cleanup),
    race.finally(cleanup),
  ]);
}

// ── FetchInstrument class ──────────────────────────────────────────────────

class FetchInstrument {
  /**
   * @param {object} [opts]  Options (see DEFAULT_OPTIONS for all keys).
   */
  constructor(opts = {}) {
    this[kOptions] = { ...DEFAULT_OPTIONS, ...opts };
    this[kOriginalFetch] = null;
    this[kIsPatched] = false;
    this[kInstalled] = false;
    this._tracer = null;
    this._log = null;

    // Counters
    this[kActiveCount] = 0;
    this[kTotalCount] = 0;
    this[kErrorCount] = 0;
    this[kTimeoutCount] = 0;
    this[kMaxLatency] = 0;
    this[kMinLatency] = Infinity;
    this[kSumLatency] = 0;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get options() {
    return this[kOptions];
  }

  get installed() {
    return this[kInstalled];
  }

  /** Snapshot of request counters. */
  get metrics() {
    return {
      active: this[kActiveCount],
      total: this[kTotalCount],
      errors: this[kErrorCount],
      timeouts: this[kTimeoutCount],
      minLatencyMs: this[kMinLatency] === Infinity ? 0 : this[kMinLatency],
      maxLatencyMs: this[kMaxLatency],
      avgLatencyMs: this[kTotalCount] > 0
        ? Math.round(this[kSumLatency] / this[kTotalCount])
        : 0,
    };
  }

  /** Reset all counters to zero. */
  resetMetrics() {
    this[kActiveCount] = 0;
    this[kTotalCount] = 0;
    this[kErrorCount] = 0;
    this[kTimeoutCount] = 0;
    this[kMaxLatency] = 0;
    this[kMinLatency] = Infinity;
    this[kSumLatency] = 0;
  }

  // ── Logger ─────────────────────────────────────────────────────────────

  _logger() {
    if (!this._log) {
      const logger = this[kOptions].logger;
      this._log = logger ? logger.child({ module: 'fetch-instrument' }) : noopLogger();
    }
    return this._log;
  }

  // ── Trace a single fetch call ──────────────────────────────────────────

  /**
   * The core instrumented fetch function.  Every outgoing call goes
   * through here when the instrument is installed, or when callers
   * invoke instrumentedFetch() or createFetch() explicitly.
   *
   * @param {string|URL|Request} input
   * @param {object}             [init]
   * @param {object}             [callOpts]  Per-call overrides (timeoutMs, logRequests, …).
   * @returns {Promise<Response>}
   */
  async _tracedFetch(input, init, callOpts = {}) {
    const opts = { ...this[kOptions], ...callOpts };
    const log = this._log || this._logger();

    // Increment active counter
    this[kActiveCount]++;

    const requestId = nextRequestId();
    const start = performance.now();

    // Build a plain URL string for logging / tracing
    let urlStr;
    let method = 'GET';
    try {
      if (typeof input === 'string') {
        urlStr = input;
      } else if (input instanceof URL) {
        urlStr = input.href;
      } else if (input instanceof Request) {
        urlStr = input.url;
        method = input.method || 'GET';
      } else {
        urlStr = String(input);
      }
    } catch {
      urlStr = '<unparseable>';
    }

    // Extract method from init if provided
    if (init && init.method) {
      method = String(init.method).toUpperCase();
    }

    // Sanitize headers before native fetch sees them.
    let safeInit;
    try {
      safeInit = sanitizeFetchInit(init || {});
    } catch {
      safeInit = { ...(init || {}) };
    }

    // Apply timeout via AbortController (unless already has one)
    const hasExternalSignal = !!(safeInit.signal || (input instanceof Request && input.signal));
    let timeoutTimer = null;
    if (opts.timeoutMs > 0 && !hasExternalSignal) {
      const controller = new AbortController();
      timeoutTimer = setTimeout(() => {
        controller.abort(new Error('request timed out'));
      }, opts.timeoutMs);
      safeInit.signal = controller.signal;
    }

    // ── OTel span ──────────────────────────────────────────────────────
    // We create a span inside the active context so it automatically
    // inherits the parent trace.  If no tracer is active the entire
    // block is a no-op.
    const tracer = this._tracer || resolveTracer(opts.tracerName);
    let span = null;

    // ── Execute ─────────────────────────────────────────────────────────
    try {
      return await tracer.startActiveSpan(
        `HTTP ${method}`,
        { kind: 2 }, // SpanKind.CLIENT
        async (activeSpan) => {
          span = activeSpan;
          activeSpan.setAttributes(spanAttrs(method, urlStr, 0, 0));
          activeSpan.setAttribute('fetch.request_id', requestId);

          // Inject propagation headers when no explicit headers override
          if (!safeInit.headers && !init?.headers) {
            const carrier = {};
            propagation.inject(context.active(), carrier);
            if (Object.keys(carrier).length > 0) {
              safeInit.headers = carrier;
            }
          }

          // Log request (before call)
          if (opts.logRequests) {
            log.info({
              requestId,
              method,
              url: logUrl(urlStr, opts.logUrlMaxLength),
              msg: 'fetch start',
            });
          }

          // Make the actual HTTP call, raced against the abort signal
          // so timeout fires even if the underlying fetch ignores the
          // AbortController (e.g. mocked fetch in tests).
          //
          // Use the original fetch saved at install() time when
          // available, falling back to globalThis.fetch.  This avoids
          // infinite recursion when install() (which patches
          // globalThis.fetch) is active — the wrapper calls
          // _tracedFetch which must NOT re-enter itself.
          const fetchFn = this[kOriginalFetch] || globalThis.fetch;
          let response;
          try {
            response = await raceWithSignal(
              fetchFn(input, safeInit),
              safeInit.signal
            );
          } catch (err) {
            throw err;
          } finally {
            // Cleanup timeout
            if (timeoutTimer) clearTimeout(timeoutTimer);
          }

          const elapsed = performance.now() - start;
          const cl = contentLength(response);

          // Update counters
          this[kTotalCount]++;
          this[kSumLatency] += elapsed;
          if (elapsed > this[kMaxLatency]) this[kMaxLatency] = elapsed;
          if (elapsed < this[kMinLatency]) this[kMinLatency] = elapsed;

          // Check if status is "successful"
          const isSuccess = isSuccessStatus(response.status, opts.successStatuses);

          // Update span
          activeSpan.setAttributes(spanAttrs(method, urlStr, response.status, elapsed, cl));
          if (isSuccess) {
            activeSpan.setStatus({ code: SpanStatusCode.OK });
          } else {
            this[kErrorCount]++;
            activeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${response.status}`,
            });
          }

          // Log response
          if (opts.logRequests) {
            const level = isSuccess ? 'info' : 'warn';
            log[level]({
              requestId,
              method,
              url: logUrl(urlStr, opts.logUrlMaxLength),
              status: response.status,
              elapsedMs: Math.round(elapsed),
              contentLength: cl,
              msg: 'fetch done',
            });
          }

          // End the span on the SUCCESS path — it was only ended in the outer
          // catch, so successful (and HTTP-error) responses leaked their span.
          activeSpan.end();
          return response;
        }
      );
    } catch (err) {
      const elapsed = performance.now() - start;

      // Update counters
      this[kTotalCount]++;
      this[kErrorCount]++;
      this[kSumLatency] += elapsed;
      if (elapsed > this[kMaxLatency]) this[kMaxLatency] = elapsed;
      if (elapsed < this[kMinLatency]) this[kMinLatency] = elapsed;

      // Detect timeout
      const isTimeout = err?.message === 'request timed out'
        || err?.code === 'FETCH_TIMEOUT'
        || err?.name === 'TimeoutError'
        || err?.cause?.message === 'request timed out';

      if (isTimeout) {
        this[kTimeoutCount]++;
      }

      // Log error
      if (opts.logRequests) {
        log.warn({
          requestId,
          method,
          url: logUrl(urlStr, opts.logUrlMaxLength),
          elapsedMs: Math.round(elapsed),
          error: redactString(err?.message),
          isTimeout,
          msg: 'fetch error',
        });
      }

      // Set span status if we have a span
      if (span) {
        span.setAttributes(spanAttrs(method, urlStr, 0, elapsed));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: isTimeout ? 'timeout' : (redactString(err?.message) || 'unknown error'),
        });
        span.recordException({
          name: err?.name || 'Error',
          message: redactString(err?.message),
          stack: redactString(err?.stack),
        });
        span.end();
      }

      throw err; // rethrow
    } finally {
      this[kActiveCount]--;
    }
  }

  // ── Install / uninstall ───────────────────────────────────────────────

  /**
   * Patch `globalThis.fetch` so every outgoing HTTP call in the process
   * is automatically traced, logged, and sanitised.
   *
   * @returns {this}
   */
  install() {
    if (this[kInstalled]) return this;

    this[kOriginalFetch] = globalThis.fetch;
    const self = this;

    globalThis.fetch = function instrumentedFetch(input, init) {
      return self._tracedFetch(input, init);
    };

    this[kInstalled] = true;
    this._log = null; // force re-init on first call

    return this;
  }

  /**
   * Restore the original `globalThis.fetch`.
   *
   * @returns {this}
   */
  uninstall() {
    if (!this[kInstalled]) return this;

    if (this[kOriginalFetch]) {
      globalThis.fetch = this[kOriginalFetch];
    }
    this[kInstalled] = false;

    return this;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  /** Return a plain-object summary for logging / health-check endpoints. */
  toJSON() {
    return {
      installed: this[kInstalled],
      options: { ...this[kOptions], logger: undefined },
      metrics: this.metrics,
    };
  }
}

// ── Module-level singleton + convenience functions ─────────────────────────

/** Default module-level FetchInstrument instance (not installed by default). */
const defaultInstrument = new FetchInstrument();

/**
 * Create a one-off instrumented fetch bound to specific options.
 *
 * @param {object} [opts]  Options (see DEFAULT_OPTIONS).
 * @returns {Function}     `(input, init?) => Promise<Response>`
 */
function createFetch(opts = {}) {
  const inst = new FetchInstrument({ ...opts });
  return (input, init) => inst._tracedFetch(input, init);
}

/**
 * Convenience: call `defaultInstrument`'s traced fetch directly without
 * installing a global patch.  Behaves exactly like the patched fetch
 * but only affects the callsite.
 *
 * @param {string|URL|Request} input
 * @param {object}             [init]
 * @param {object}             [callOpts]
 * @returns {Promise<Response>}
 */
function instrumentedFetch(input, init, callOpts) {
  return defaultInstrument._tracedFetch(input, init, callOpts);
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  FetchInstrument,
  createFetch,
  instrumentedFetch,
  defaultInstrument,
  sanitizeFetchInit, // re-export so callers don't need a second require
};
