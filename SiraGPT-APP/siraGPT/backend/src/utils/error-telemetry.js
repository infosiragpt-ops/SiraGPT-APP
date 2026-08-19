// ─────────────────────────────────────────────────────────────────
// siraGPT — Structured error telemetry bridge.
// ─────────────────────────────────────────────────────────────────
// Connects the reliability modules (CircuitBreaker, retry-with-backoff,
// async-guard, fetch-instrument) to the Observability Plane's span
// system and logger, so every circuit-open event, retry attempt, and
// guarded-execution failure produces a structured trace with error
// context, classification, and recovery metadata.
//
// Architecture
// ------------
// The `ErrorReporter` is a factory created with a tracer (from
// spans.js or a real OTel Tracer). It exposes:
//
//   - wireCircuitBreaker(cb)        — subscribe to stateChange events
//   - captureError(error, context)  — record a structured error snapshot
//   - captureRetry(info)            — record a retry attempt as span event
//   - captureGuardTimeout(info)     — record an async-guard timeout
//
// When no tracer is available (tests / missing import), all methods
// degrade gracefully to structured logging via console.warn —
// the system works identically, just without OTel spans.
// ─────────────────────────────────────────────────────────────────

const { STATE } = require('./circuit-breaker');

// ── Severity levels ────────────────────────────────────────────────────────
const LEVEL = Object.freeze({
  DEBUG: 'debug',
  INFO:  'info',
  WARN:  'warn',
  ERROR: 'error',
  FATAL: 'fatal',
});

// ── Default logger ─────────────────────────────────────────────────────────
// In production, the app injects its own logger (e.g. Pino). Tests and
// bare imports fall back to console.
const LEVEL_FN = {
  debug: (msg, meta) => console.debug(`[telemetry] ${msg}`, meta ? JSON.stringify(meta) : ''),
  info:  (msg, meta) => console.info(`[telemetry] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn:  (msg, meta) => console.warn(`[telemetry] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[telemetry] ${msg}`, meta ? JSON.stringify(meta) : ''),
  fatal: (msg, meta) => console.error(`[telemetry] ${msg}`, meta ? JSON.stringify(meta) : ''),
};

// ── Classification helpers ─────────────────────────────────────────────────

const ERROR_CATEGORIES = Object.freeze({
  NETWORK:      'network',
  TIMEOUT:      'timeout',
  RATE_LIMIT:   'rate_limit',
  AUTH:         'auth',
  BIZ:          'business_logic',
  SYSTEM:       'system',
  UNKNOWN:      'unknown',
});

/**
 * Classify a generic Error into one of ERROR_CATEGORIES.
 * Intentionally simpler than classifyTaskError() — this is for
 * telemetry categorization (dashboard filtering), not retry decisions.
 */
function classifyError(err) {
  if (!err) return ERROR_CATEGORIES.UNKNOWN;
  const msg = String(err.message || err).toLowerCase();
  const name = String(err.name || '').toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();

  if (name.includes('circuitopen') || name === 'circuitopenerror') return ERROR_CATEGORIES.SYSTEM;
  if (name.includes('circuittimeout') || name === 'circuittimeouterror') return ERROR_CATEGORIES.TIMEOUT;
  if (name.includes('guard') || name === 'guarderror') return ERROR_CATEGORIES.TIMEOUT;
  if (code.startsWith('5') || code.startsWith('5')) return ERROR_CATEGORIES.NETWORK;
  if (code === '408' || code === '504' || name.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout')) return ERROR_CATEGORIES.TIMEOUT;
  if (code.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return ERROR_CATEGORIES.RATE_LIMIT;
  if (code === '401' || code === '403' || name.includes('auth') || msg.includes('unauthorized') || msg.includes('api_key')) return ERROR_CATEGORIES.AUTH;

  return ERROR_CATEGORIES.UNKNOWN;
}

/**
 * Extract a structured error snapshot safe for serialization.
 * Never throws — always returns a plain object.
 */
function errorToSnapshot(err, maxDepth = 3) {
  if (!err) return { message: 'unknown error', name: 'Error' };
  const snapshot = {
    message: (err.message || String(err)).slice(0, 500),
    name: err.name || 'Error',
    stack: err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
    code: err.code || err.statusCode || undefined,
    category: classifyError(err),
  };
  // Capture cause chain up to maxDepth
  let cause = err.cause;
  for (let i = 0; i < maxDepth && cause; i++) {
    const key = `cause${i + 1}`;
    snapshot[key] = (cause.message || String(cause)).slice(0, 500);
    cause = cause.cause;
  }
  // Extract known properties from circuit-breaker errors
  if (err.breakerName) snapshot.breakerName = err.breakerName;
  if (err.timeoutMs) snapshot.timeoutMs = err.timeoutMs;
  return snapshot;
}

// ── ErrorReporter factory ──────────────────────────────────────────────────

/**
 * Create an ErrorReporter bound to a tracer and optional logger.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.tracer]        - A tracer from spans.js { startSpan, withSpan }
 * @param {object}   [opts.logger]        - A logger with .info/.warn/.error/.debug
 * @param {string}   [opts.service='siragpt-backend']
 * @returns {ErrorReporter}
 */
function createErrorReporter(opts = {}) {
  const tracer = opts.tracer || null;
  const log = opts.logger ? { ...LEVEL_FN, ...pickLoggerMethods(opts.logger) } : LEVEL_FN;
  const service = opts.service || 'siragpt-backend';

  // Track which circuit breakers we've wired (avoid double-sub)
  const wiredBreakers = new Set();

  const reporter = {
    service,
    tracer,

    /**
     * Subscribe to a CircuitBreaker's stateChange events and emit
     * corresponding span events + log lines.
     *
     * @param {import('./circuit-breaker').CircuitBreaker} cb
     * @returns {Function}  unsubscribe function
     */
    wireCircuitBreaker(cb) {
      if (!cb || typeof cb.on !== 'function') {
        log.warn('wireCircuitBreaker: not an EventEmitter', { name: cb?.constructor?.name });
        return () => {};
      }
      const name = cb.name || cb.constructor?.name || 'unnamed';
      if (wiredBreakers.has(name)) {
        log.debug('wireCircuitBreaker: already wired', { name });
        return () => {};
      }
      wiredBreakers.add(name);

      const handler = (event) => {
        const { from, to, name: breakerName } = event || {};
        const msg = `Circuit breaker "${breakerName || name}" state change: ${from} → ${to}`;

        const level = to === 'OPEN' ? 'error' : (to === 'HALF_OPEN' ? 'warn' : 'info');
        const meta = {
          module: 'circuit-breaker',
          breaker: breakerName || name,
          from,
          to,
          timestamp: new Date().toISOString(),
        };

        log[level](msg, meta);

        // If we have a tracer, emit a span event
        if (tracer?.startSpan) {
          // We create a zero-duration event-span to capture the transition
          const span = tracer.startSpan({
            name: `circuit-breaker.${to.toLowerCase()}`,
            attributes: meta,
          });
          span.end();
        }
      };

      cb.on('stateChange', handler);

      // Return unsubscribe
      return () => {
        cb.off('stateChange', handler);
        wiredBreakers.delete(name);
      };
    },

    /**
     * Record a structured error with context.
     *
     * @param {Error}     err         - The error to record
     * @param {object}    [context]   - { module, operation, attempt, metadata }
     * @param {object}    [span]      - Active span to annotate (optional)
     * @returns {object}  snapshot  - The recorded error snapshot
     */
    captureError(err, context = {}, span = null) {
      const snapshot = errorToSnapshot(err);
      const meta = {
        module: context.module || 'unknown',
        operation: context.operation || 'unknown',
        category: snapshot.category,
        error: snapshot,
        ...(context.metadata || {}),
      };

      const msg = `Error in ${meta.module}.${meta.operation}: ${err?.message || 'unknown'}`;
      log.error(msg, meta);

      // Annotate active span
      if (span && typeof span.addEvent === 'function') {
        span.addEvent('exception', {
          'exception.type': snapshot.name,
          'exception.message': snapshot.message,
          'exception.stacktrace': snapshot.stack || '',
          'operation': meta.operation,
          'module': meta.module,
          'category': meta.category,
        });
        span.setStatus('error', snapshot.message);
      }

      return snapshot;
    },

    /**
     * Record a retry attempt as telemetry.
     *
     * @param {object} info  - { attempt, delayMs, error, reason }
     * @param {object} [context] - { module, operation }
     * @param {object} [span]    - Active span to annotate
     */
    captureRetry(info = {}, context = {}, span = null) {
      const meta = {
        module: context.module || 'unknown',
        operation: context.operation || 'unknown',
        retryAttempt: info.attempt,
        retryDelayMs: info.delayMs,
        retryReason: info.reason || 'unknown',
        timestamp: new Date().toISOString(),
      };

      if (info.error) {
        meta.error = errorToSnapshot(info.error);
      }

      const msg = `Retry ${meta.retryAttempt} in ${meta.module}.${meta.operation}: ${meta.retryReason}`;
      log.warn(msg, meta);

      if (span && typeof span.addEvent === 'function') {
        span.addEvent('retry', meta);
      }
    },

    /**
     * Record an async-guard timeout event.
     *
     * @param {object}  info    - { timeoutMs, operation, error }
     * @param {object}  [span]  - Active span
     */
    captureGuardTimeout(info = {}, span = null) {
      const meta = {
        module: 'async-guard',
        operation: info.operation || 'unknown',
        timeoutMs: info.timeoutMs,
        timestamp: new Date().toISOString(),
      };

      if (info.error) meta.error = errorToSnapshot(info.error);

      const msg = `Guard timeout (${meta.timeoutMs}ms) in ${meta.operation}`;
      log.warn(msg, meta);

      if (span && typeof span.addEvent === 'function') {
        span.addEvent('guard_timeout', meta);
      }
    },

    /**
     * Return a middleware-compatible function that captures errors
     * flowing through Express error handlers with request context.
     *
     * Usage: app.use(reporter.expressErrorHandler());
     */
    expressErrorHandler() {
      return (err, req, res, next) => {
        const context = {
          module: 'express',
          operation: `${req.method} ${req.originalUrl || req.url}`,
          metadata: {
            requestId: req.id || req.requestId,
            userId: req.user?.id,
          },
        };
        reporter.captureError(err, context);
        next(err); // Let the normal error handler send the response
      };
    },
  };

  return reporter;
}

/**
 * Extract .info/.warn/.error/.debug from a structured logger (Pino, etc.)
 * so the reporter uses the right level methods.
 */
function pickLoggerMethods(logger) {
  if (!logger || typeof logger !== 'object') return {};
  const picked = {};
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
    if (typeof logger[level] === 'function') picked[level] = logger[level].bind(logger);
  }
  return picked;
}

module.exports = {
  createErrorReporter,
  errorToSnapshot,
  classifyError,
  ERROR_CATEGORIES,
  LEVEL,
};
