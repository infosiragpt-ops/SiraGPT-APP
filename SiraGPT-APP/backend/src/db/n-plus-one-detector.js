'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — N+1 Query Detector
// ──────────────────────────────────────────────────────────────
// Per-request middleware that records every Prisma query and
// flags repeated identical query *shapes* — same model, same
// operation, same WHERE/select/include keys, only literal values
// differing. When the same signature repeats `threshold` times
// within `windowMs`, a structured warning is emitted.
//
// The detector uses AsyncLocalStorage to isolate counters per
// request so concurrent traffic doesn't bleed into the same
// bucket. Outside of a request scope (background jobs, cron) the
// recorder is a no-op unless `runInScope()` is used explicitly.
//
// Tunables (env):
//   NPLUS1_THRESHOLD   — repetitions before warning (default 5)
//   NPLUS1_WINDOW_MS   — span over which the count is meaningful
//                        (default 1000ms; resets if exceeded)
// ──────────────────────────────────────────────────────────────

const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_MAX_WARNINGS = 100;

function readNumber(envName, fallback) {
  const raw = process.env[envName];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Builds a structural fingerprint of a value: keys + types only,
// never literals. Two `where` objects with the same key set but
// different ids collapse to the same shape — that's the whole
// point of the detector.
function shapeOf(value, depth) {
  if (depth > 4) return '*';
  if (value === null) return 'null';
  if (value === undefined) return 'undef';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[' + shapeOf(value[0], depth + 1) + ']';
  }
  const t = typeof value;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    const parts = [];
    for (const k of keys) parts.push(k + ':' + shapeOf(value[k], depth + 1));
    return '{' + parts.join(',') + '}';
  }
  return t;
}

function signatureOf(model, operation, args) {
  const where = args && args.where ? shapeOf(args.where, 0) : '';
  const select = args && args.select ? shapeOf(args.select, 0) : '';
  const include = args && args.include ? shapeOf(args.include, 0) : '';
  const orderBy = args && args.orderBy ? shapeOf(args.orderBy, 0) : '';
  return `${model || '*'}#${operation || '*'}|w=${where}|s=${select}|i=${include}|o=${orderBy}`;
}

function createNPlusOneDetector(opts = {}) {
  const threshold = Math.max(2, opts.threshold != null
    ? opts.threshold
    : readNumber('NPLUS1_THRESHOLD', DEFAULT_THRESHOLD));
  const windowMs = Math.max(1, opts.windowMs != null
    ? opts.windowMs
    : readNumber('NPLUS1_WINDOW_MS', DEFAULT_WINDOW_MS));
  const maxWarnings = Math.max(1, opts.maxWarnings != null
    ? opts.maxWarnings
    : readNumber('NPLUS1_MAX_WARNINGS', DEFAULT_MAX_WARNINGS));
  const logger = opts.logger || console;
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const storage = opts.storage || new AsyncLocalStorage();

  const warnings = [];
  let warningsTotal = 0;

  function newScope(meta) {
    return {
      requestId: (meta && meta.requestId) || null,
      route: (meta && meta.route) || null,
      method: (meta && meta.method) || null,
      startedAt: now(),
      counters: new Map(),
      warned: new Set(),
    };
  }

  function emitWarning(info) {
    if (warnings.length >= maxWarnings) warnings.shift();
    warnings.push(info);
    warningsTotal += 1;
    if (onWarn) {
      try { onWarn(info); } catch { /* listener must never break the query path */ }
      return;
    }
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[n+1-detected]', JSON.stringify({
        signature: info.signature,
        count: info.count,
        threshold: info.threshold,
        elapsedMs: info.elapsedMs,
        route: info.route,
        method: info.method,
        requestId: info.requestId,
        model: info.model,
        operation: info.operation,
      }));
    }
  }

  function track(input) {
    const scope = storage.getStore();
    if (!scope) return null;
    const model = input && input.model ? input.model : null;
    const operation = input && input.operation ? input.operation : null;
    const args = input ? input.args : null;
    const signature = signatureOf(model, operation, args);
    const t = now();

    let entry = scope.counters.get(signature);
    if (!entry || (t - entry.firstAt) > windowMs) {
      entry = { count: 0, firstAt: t, lastAt: t, model, operation };
      scope.counters.set(signature, entry);
      // Re-arm warning so a fresh burst in a long-lived scope is flagged again.
      scope.warned.delete(signature);
    }
    entry.count += 1;
    entry.lastAt = t;

    if (entry.count >= threshold && !scope.warned.has(signature)) {
      scope.warned.add(signature);
      emitWarning({
        ts: new Date().toISOString(),
        requestId: scope.requestId,
        route: scope.route,
        method: scope.method,
        signature,
        model,
        operation,
        count: entry.count,
        threshold,
        windowMs,
        elapsedMs: entry.lastAt - entry.firstAt,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
      });
    }
    return entry;
  }

  function middleware() {
    return function nPlusOneScope(req, res, next) {
      const headers = req && req.headers ? req.headers : {};
      const meta = {
        requestId: (req && req.id)
          || headers['x-request-id']
          || headers['x-correlation-id']
          || null,
        route: req && (req.originalUrl || req.url) || null,
        method: req && req.method || null,
      };
      storage.run(newScope(meta), () => next());
    };
  }

  function runInScope(meta, fn) {
    return storage.run(newScope(meta || {}), fn);
  }

  function getCurrentScope() {
    return storage.getStore() || null;
  }

  function getWarnings(limit) {
    if (warnings.length === 0) return [];
    const cap = Math.max(1, Math.min(limit || warnings.length, warnings.length));
    return warnings.slice(-cap).reverse();
  }

  function getStats() {
    return {
      threshold,
      windowMs,
      maxWarnings,
      warningsBuffered: warnings.length,
      warningsTotal,
    };
  }

  function reset() {
    warnings.length = 0;
    warningsTotal = 0;
  }

  const extension = {
    name: 'siraGPTNPlusOneDetector',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          track({ model, operation, args });
          return query(args);
        },
      },
    },
  };

  return {
    extension,
    track,
    middleware,
    runInScope,
    getCurrentScope,
    getWarnings,
    getStats,
    reset,
    signatureOf,
  };
}

module.exports = { createNPlusOneDetector, signatureOf };
