'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Slow Query Logger (Prisma)
// ──────────────────────────────────────────────────────────────
// Prisma client extension that times every query and records the
// ones that exceed a configurable threshold to an in-memory ring
// buffer. Fast queries pay only Date.now() + a sampling check, so
// the hot path stays cheap. The buffer is exposed via
// `getSlowQueries()` for the /internal/db/slow-queries endpoint.
//
// Sampling defaults: 100% in dev/test, 1% in production. Override
// with SLOW_QUERY_SAMPLE_RATE (0..1).
//
// Threshold: SLOW_QUERY_THRESHOLD_MS (default 200).
//
// Buffer size: SLOW_QUERY_BUFFER_SIZE (default 200).
// ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_MS = 200;
const DEFAULT_BUFFER_SIZE = 200;

function readNumber(envName, fallback) {
  const raw = process.env[envName];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultSampleRate() {
  const env = process.env.NODE_ENV;
  return env === 'production' ? 0.01 : 1;
}

function captureStack() {
  // Walk past internal frames so the stored stack points at the caller.
  const err = { name: 'SlowQuery' };
  Error.captureStackTrace(err, captureStack);
  const lines = String(err.stack || '').split('\n').slice(1, 12);
  return lines.map((l) => l.trim()).join('\n');
}

function sanitizeArgs(args) {
  // Args can be deeply nested (where/data/include); JSON.stringify with
  // a length cap is good enough for diagnostics, and it avoids leaking
  // class instances or buffers. We pre-walk to neutralize bigints,
  // buffers and cycles before handing off to JSON.stringify, because
  // its replacer fires *after* toJSON() and would never see a Buffer.
  try {
    const seen = new WeakMap();
    const walk = (value) => {
      if (value === null || value === undefined) return value;
      if (typeof value === 'bigint') return value.toString() + 'n';
      if (Buffer.isBuffer(value)) return `<Buffer length=${value.length}>`;
      if (typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular]';
      if (Array.isArray(value)) {
        const arr = [];
        seen.set(value, arr);
        for (const item of value) arr.push(walk(item));
        return arr;
      }
      const out = {};
      seen.set(value, out);
      for (const k of Object.keys(value)) out[k] = walk(value[k]);
      return out;
    };
    const json = JSON.stringify(walk(args ?? null));
    if (!json) return null;
    return json.length > 4096 ? json.slice(0, 4096) + '…' : json;
  } catch {
    return '<unserializable>';
  }
}

function createSlowQueryLogger(opts = {}) {
  const thresholdMs = opts.thresholdMs != null
    ? opts.thresholdMs
    : readNumber('SLOW_QUERY_THRESHOLD_MS', DEFAULT_THRESHOLD_MS);
  const sampleRate = opts.sampleRate != null
    ? opts.sampleRate
    : readNumber('SLOW_QUERY_SAMPLE_RATE', defaultSampleRate());
  const bufferSize = Math.max(1, opts.bufferSize != null
    ? opts.bufferSize
    : readNumber('SLOW_QUERY_BUFFER_SIZE', DEFAULT_BUFFER_SIZE));
  const onSlow = typeof opts.onSlow === 'function' ? opts.onSlow : null;
  const logger = opts.logger || console;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const buffer = new Array(bufferSize);
  let cursor = 0;
  let total = 0;
  const stats = {
    queries: 0,
    sampled: 0,
    slow: 0,
    lastSlowAt: null,
  };

  function record(entry) {
    buffer[cursor] = entry;
    cursor = (cursor + 1) % bufferSize;
    total += 1;
  }

  async function tracedQuery({ model, operation, args, query }) {
    stats.queries += 1;
    const sample = sampleRate >= 1 || random() < sampleRate;
    if (!sample) return query(args);
    stats.sampled += 1;

    const startedAt = now();
    let success = true;
    let errCode = null;
    try {
      return await query(args);
    } catch (err) {
      success = false;
      errCode = err && (err.code || err.name) || 'unknown';
      throw err;
    } finally {
      const durationMs = now() - startedAt;
      if (durationMs >= thresholdMs) {
        stats.slow += 1;
        stats.lastSlowAt = new Date().toISOString();
        const entry = {
          ts: stats.lastSlowAt,
          model: model || null,
          operation: operation || null,
          durationMs,
          thresholdMs,
          args: sanitizeArgs(args),
          success,
          errorCode: errCode,
          stack: captureStack(),
        };
        record(entry);
        if (onSlow) {
          try { onSlow(entry); } catch { /* never let listener break the query */ }
        } else if (logger && typeof logger.warn === 'function') {
          logger.warn('[slow-query]', JSON.stringify({
            model: entry.model,
            operation: entry.operation,
            durationMs: entry.durationMs,
            success: entry.success,
            errorCode: entry.errorCode,
          }));
        }
      }
    }
  }

  function getSlowQueries(limit) {
    const out = [];
    const n = Math.min(bufferSize, total);
    const cap = Math.max(1, Math.min(limit || n, n));
    // Walk newest -> oldest.
    for (let i = 0; i < n && out.length < cap; i++) {
      const idx = (cursor - 1 - i + bufferSize) % bufferSize;
      const item = buffer[idx];
      if (item) out.push(item);
    }
    return out;
  }

  function getStats() {
    return {
      ...stats,
      thresholdMs,
      sampleRate,
      bufferSize,
      bufferUsed: Math.min(total, bufferSize),
    };
  }

  function reset() {
    for (let i = 0; i < bufferSize; i++) buffer[i] = undefined;
    cursor = 0;
    total = 0;
    stats.queries = 0;
    stats.sampled = 0;
    stats.slow = 0;
    stats.lastSlowAt = null;
  }

  // Returns a Prisma client extension definition compatible with
  // `prisma.$extends(extension)`. We also expose `tracedQuery`
  // directly so unit tests can drive it without a full Prisma client.
  const extension = {
    name: 'siraGPTSlowQueryLogger',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return tracedQuery({ model, operation, args, query });
        },
      },
    },
  };

  return {
    extension,
    tracedQuery,
    getSlowQueries,
    getStats,
    reset,
  };
}

module.exports = { createSlowQueryLogger };
