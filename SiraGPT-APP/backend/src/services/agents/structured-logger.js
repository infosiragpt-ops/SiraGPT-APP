/**
 * structured-logger — structured, correlated logging for agent operations.
 *
 * Problem:
 *   Console.log/fmt messages lack structure, correlation IDs, and severity
 *   levels. When debugging a multi-agent orchestration, you can't easily
 *   filter logs by trace, find all errors for a specific user, or aggregate
 *   operation latencies.
 *
 * Solution:
 *   A structured logger that wraps every log line with:
 *     - Timestamp (ISO-8601 with ms)
 *     - Level (debug, info, warn, error, fatal)
 *     - Service name
 *     - Correlation trace ID
 *     - Module/component name
 *     - Structured data (JSON payload)
 *
 * Output is JSON Lines (one JSON object per line) — parseable by any
 * log aggregator (ELK, Loki, Datadog, etc.) without custom parsing rules.
 *
 * Usage:
 *   const log = getLogger('agent-orchestrator');
 *   log.info('orchestration started', { orchestrationId, subTaskCount: 5 });
 *   log.error('orchestration failed', { orchestrationId, error: err.message });
 *
 *   // With trace context:
 *   const ctx = { traceId: 'abc-123' };
 *   log.withTrace(ctx).warn('sub-agent timeout', { subTaskId: 'xyz' });
 */

const { redactPayloadDeep } = require('../../utils/log-redaction');

const LEVELS = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
});

const LEVEL_NAMES = Object.keys(LEVELS);

const DEFAULT_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_NAME = process.env.SERVICE_NAME || 'siragpt';

// ─── Formatting helpers ────────────────────────────────────────────────────

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Sanitize an error into a plain object suitable for JSON serialization.
 * Error objects lose their non-enumerable properties (message, stack)
 * in JSON.stringify without this.
 */
function errorToObject(err) {
  if (!err || typeof err !== 'object') return err;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack,
    ...Object.getOwnPropertyNames(err).reduce((acc, key) => {
      acc[key] = err[key];
      return acc;
    }, {}),
  };
}

/**
 * Truncate strings and deeply nested objects to keep log lines manageable.
 */
function truncateData(data, maxDepth = 5, maxStringLen = 500) {
  if (typeof data === 'string') {
    return data.length > maxStringLen ? data.slice(0, maxStringLen) + '…' : data;
  }
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }
  if (maxDepth <= 0) return '[truncated]';

  if (Array.isArray(data)) {
    return data.slice(0, 20).map(item => truncateData(item, maxDepth - 1, maxStringLen));
  }

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    try {
      result[key] = truncateData(value, maxDepth - 1, maxStringLen);
    } catch {
      result[key] = '[circular]';
    }
  }
  return result;
}

// ─── Logger ────────────────────────────────────────────────────────────────

class StructuredLogger {
  /**
   * @param {string} component  — module or component name
   * @param {object} [opts]
   * @param {string} [opts.level]      — minimum level to emit
   * @param {string} [opts.traceId]    — correlation ID for this logger instance
   * @param {object} [opts.baseData]   — static data attached to every log line
   * @param {Function} [opts.transport] — custom output function (default: process.stdout)
   * @param {boolean} [opts.pretty]    — pretty-print for development (default: false)
   */
  constructor(component, opts = {}) {
    if (!component) throw new Error('StructuredLogger: component is required');
    this.component = component;
    this.minLevel = LEVELS[opts.level || DEFAULT_LEVEL] ?? LEVELS.info;
    this.traceId = opts.traceId || null;
    this.baseData = opts.baseData || {};
    this.transport = opts.transport || ((line) => process.stdout.write(line + '\n'));
    this.pretty = opts.pretty ?? (process.env.NODE_ENV === 'development');
  }

  /**
   * Create a child logger with additional base data.
   * @param {object} extraData  — merged with existing baseData
   * @returns {StructuredLogger}
   */
  child(extraData) {
    return new StructuredLogger(this.component, {
      level: LEVEL_NAMES[this.minLevel],
      traceId: this.traceId,
      baseData: { ...this.baseData, ...extraData },
      transport: this.transport,
      pretty: this.pretty,
    });
  }

  /**
   * Create a logger bound to a specific trace context.
   * @param {object} traceCtx  — must have a `traceId` property
   * @returns {StructuredLogger}
   */
  withTrace(traceCtx) {
    return new StructuredLogger(this.component, {
      level: LEVEL_NAMES[this.minLevel],
      traceId: traceCtx?.traceId || traceCtx?.orchestrationId || this.traceId,
      baseData: { ...this.baseData },
      transport: this.transport,
      pretty: this.pretty,
    });
  }

  /**
   * Core log method.
   */
  _log(level, message, data = {}) {
    if (LEVELS[level] == null) return;
    if (LEVELS[level] < this.minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      component: this.component,
      message,
    };

    if (this.traceId) entry.traceId = this.traceId;

    const safeData = redactPayloadDeep(data);

    // Merge base data
    if (Object.keys(this.baseData).length > 0) {
      entry.data = truncateData(redactPayloadDeep({ ...this.baseData, ...data }));
    } else if (Object.keys(safeData).length > 0) {
      entry.data = truncateData(safeData);
    }

    // Handle error objects specially
    if (data.error && data.error instanceof Error) {
      entry.error = errorToObject(data.error);
    }

    if (this.pretty) {
      this._prettyPrint(entry);
    } else {
      try {
        this.transport(JSON.stringify(entry));
      } catch (err) {
        // Last-resort fallback — never let logging break the app
        process.stderr.write(`[LOG_ERROR] ${err.message}\n`);
      }
    }
  }

  /**
   * Human-readable pretty-print for development.
   */
  _prettyPrint(entry) {
    const time = entry.timestamp.slice(11, 23);
    const prefix = `${time} [${entry.level.toUpperCase().padEnd(5)}] [${entry.component}]`;
    const suffix = entry.traceId ? ` trace=${entry.traceId}` : '';
    const line = `${prefix}${suffix}: ${entry.message}`;
    const dest = entry.level === 'error' || entry.level === 'fatal' ? process.stderr : process.stdout;
    dest.write(line + '\n');

    if (entry.data && Object.keys(entry.data).length > 0) {
      dest.write(`  └─ ${JSON.stringify(truncateData(entry.data, 3, 200))}\n`);
    }
    if (entry.error) {
      dest.write(`  └─ ${entry.error.name}: ${entry.error.message}\n`);
    }
  }

  // ── Level-specific methods ──────────────────────────────────────────

  debug(message, data) { this._log('debug', message, data); }
  info(message, data) { this._log('info', message, data); }
  warn(message, data) { this._log('warn', message, data); }
  error(message, data) { this._log('error', message, data); }
  fatal(message, data) { this._log('fatal', message, data); }

  /**
   * Log an operation with timing.
   * Wraps an async function, logging start + duration on completion.
   *
   * @param {string} operation  — operation name
   * @param {Function} fn       — async () => T
   * @param {object} [data]     — additional context
   * @returns {Promise<T>}
   */
  async timed(operation, fn, data = {}) {
    const start = Date.now();
    this.info(`→ ${operation}`, { ...data, operation, phase: 'start' });

    try {
      const result = await fn();
      const durationMs = Date.now() - start;
      this.info(`✓ ${operation}`, { ...data, operation, phase: 'end', durationMs });
      if (typeof result !== 'undefined' && result !== null) {
        return result;
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      this.error(`✗ ${operation}`, { ...data, operation, phase: 'error', durationMs, error: err });
      throw err;
    }
  }
}

// ─── Logger factory ────────────────────────────────────────────────────────

const _loggers = new Map();

/**
 * Get or create a named logger.
 *
 * @param {string} component  — module/component name
 * @param {object} [opts]
 * @returns {StructuredLogger}
 */
function getLogger(component, opts = {}) {
  if (!component) return getLogger('default');
  const key = component;
  let logger = _loggers.get(key);
  if (!logger) {
    logger = new StructuredLogger(component, opts);
    _loggers.set(key, logger);
  }
  return logger;
}

/**
 * Reset all loggers (useful in tests).
 */
function _resetLoggers() {
  _loggers.clear();
}

// ─── Tracing helpers ──────────────────────────────────────────────────────

/**
 * Generate a unique trace ID.
 * Format: {random-hex}-{timestamp-ms-hex}
 */
function generateTraceId() {
  const random = require('crypto').randomBytes(8).toString('hex');
  const ts = Date.now().toString(16);
  return `${random}-${ts}`;
}

/**
 * Create a trace context that can be passed through the system.
 *
 * @param {object} [parent]  — parent trace context to inherit from
 * @returns {{ traceId: string, spanId: string, parentSpanId: string|null }}
 */
function createTraceContext(parent = null) {
  const traceId = parent?.traceId || generateTraceId();
  const spanId = generateTraceId().slice(0, 16);
  return { traceId, spanId, parentSpanId: parent?.spanId || null };
}

module.exports = {
  StructuredLogger,
  getLogger,
  generateTraceId,
  createTraceContext,
  _resetLoggers,
  LEVELS,
  LEVEL_NAMES,
};
