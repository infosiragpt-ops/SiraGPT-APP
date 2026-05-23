'use strict';

/**
 * rate-limit-auth — sliding-window rate limit middleware specifically
 * tuned for the auth surface (login / register / forgot-password / etc).
 *
 * Why a dedicated module:
 *   The catch-all `authLimiter` in index.js applies a single windowed
 *   cap across the entire /api/auth/* tree. That works fine for the
 *   read-only OAuth status endpoints, but credential-stuffing /
 *   password-spray attacks need *tighter* per-endpoint caps. Bolting
 *   per-route counters onto express-rate-limit means juggling N store
 *   instances — instead, we lean on the sliding-window `consume()` API
 *   already exposed by rate-limit-store (Redis ZSET, in-memory
 *   fallback) and build a small middleware factory around it.
 *
 * Contract:
 *   makeAuthRateLimit({ name, limit, windowMs, keyBy })
 *     - name:     short label used in the Redis key prefix + 429 body.
 *     - limit:    max attempts in the window.
 *     - windowMs: window length in ms.
 *     - keyBy:    'ip' (default) | 'ip+email' | function(req) => string
 *
 *   On exhaustion responds with:
 *     - HTTP 429
 *     - Retry-After header in seconds (rounded up)
 *     - JSON body { error, retryAfterMs }
 *
 *   On any consume() error (shouldn't happen — the store fails open
 *   internally) we let the request through to avoid bricking auth
 *   during a Redis outage. This matches the broader fail-open posture
 *   used by the catch-all limiters in index.js (`passOnStoreError`).
 */

const { consume } = require('./rate-limit-store');
const crypto = require('node:crypto');
const { getRequestId } = require('./request-id');

const MAX_KEY_SEGMENT_LENGTH = 128;
const SAFE_KEY_SEGMENT_RE = /^[A-Za-z0-9._~:@-]+$/;

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function normalizeKeySegment(value, opts = {}) {
  const label = opts.label || 'segment';
  const raw = String(value || '').trim();
  if (!raw) return opts.fallback || 'unknown';
  if (!opts.hash && raw.length <= MAX_KEY_SEGMENT_LENGTH && SAFE_KEY_SEGMENT_RE.test(raw)) {
    return raw;
  }
  return `${label}_${stableHash(raw)}`;
}

function normalizeIp(value) {
  const first = firstHeaderValue(value);
  if (first == null) return '';
  const ip = String(first).split(',')[0].trim();
  if (!ip || ip.length > MAX_KEY_SEGMENT_LENGTH) return '';
  if (/[\r\n\0]/.test(ip)) return '';
  if (!SAFE_KEY_SEGMENT_RE.test(ip)) return '';
  return ip;
}

function pickIp(req) {
  return (
    normalizeIp(req.ip)
    || normalizeIp(req.headers && req.headers['x-forwarded-for'])
    || normalizeIp(req.connection && req.connection.remoteAddress)
    || 'unknown'
  );
}

function pickEmail(req) {
  const raw = req.body && (req.body.email || req.body.username);
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().slice(0, 254);
}

function normalizeLimitName(name) {
  const raw = String(name || 'generic').trim().toLowerCase();
  if (!raw) return 'generic';
  return normalizeKeySegment(raw.replace(/[^a-z0-9_-]+/g, '-'), { fallback: 'generic' });
}

function resolveKey(req, keyBy, name) {
  const safeName = normalizeLimitName(name);
  if (typeof keyBy === 'function') {
    try {
      const k = keyBy(req);
      if (typeof k === 'string' && k.trim().length > 0) {
        return `authrl:${safeName}:${normalizeKeySegment(k, { label: 'custom' })}`;
      }
    } catch (_) { /* fall through */ }
  }
  if (keyBy === 'ip+email') {
    const email = pickEmail(req);
    const emailKey = email ? normalizeKeySegment(email, { hash: true, label: 'email' }) : 'noemail';
    return `authrl:${safeName}:${pickIp(req)}:${emailKey}`;
  }
  return `authrl:${safeName}:${pickIp(req)}`;
}

function setResponseHeader(res, name, value) {
  if (res && typeof res.setHeader === 'function') return res.setHeader(name, value);
  if (res && typeof res.set === 'function') return res.set(name, value);
  return undefined;
}

function setRateLimitHeaders(res, { limit, remaining, resetAt, retryAfterSec }) {
  setResponseHeader(res, 'RateLimit-Limit', String(limit));
  setResponseHeader(res, 'RateLimit-Remaining', String(Math.max(0, remaining)));
  setResponseHeader(res, 'RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
  if (retryAfterSec != null) setResponseHeader(res, 'Retry-After', String(retryAfterSec));
}

function setBlockedResponseHeaders(res) {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  setResponseHeader(res, 'X-Content-Type-Options', 'nosniff');
}

function normalizeResetAt(value, windowMs) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isFinite(date.getTime())) return date;
  return new Date(Date.now() + windowMs);
}

function makeAuthRateLimit(opts = {}) {
  const name = normalizeLimitName(opts.name);
  const limit = Number(opts.limit);
  const windowMs = Number(opts.windowMs);
  const keyBy = opts.keyBy || 'ip';

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('makeAuthRateLimit: opts.limit must be a positive number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('makeAuthRateLimit: opts.windowMs must be a positive number');
  }

  return async function authRateLimit(req, res, next) {
    // Fail-open: a misbehaving rate-limiter must never break auth.
    try {
      const key = resolveKey(req, keyBy, name);
      const result = await consume(key, limit, windowMs);
      const resetAt = normalizeResetAt(result.resetAt, windowMs);
      if (!result.allowed) {
        const retryAfterMs = Math.max(0, resetAt.getTime() - Date.now());
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        setBlockedResponseHeaders(res);
        setRateLimitHeaders(res, { limit, remaining: 0, resetAt, retryAfterSec });
        const payload = {
          ok: false,
          code: 'rate_limited',
          error: `Too many ${name} attempts. Please try again later.`,
          retryAfterMs,
          retryAfterSec,
        };
        const requestId = getRequestId(req);
        if (requestId) payload.requestId = requestId;
        return res.status(429).json(payload);
      }
      // Surface remaining for debugging + clients that want to back off
      // proactively rather than be 429'd.
      setRateLimitHeaders(res, { limit, remaining: result.remaining, resetAt });
      return next();
    } catch (_err) {
      return next();
    }
  };
}

module.exports = {
  makeAuthRateLimit,
  // exported for tests
  _pickIp: pickIp,
  _pickEmail: pickEmail,
  _resolveKey: resolveKey,
  _normalizeKeySegment: normalizeKeySegment,
  _normalizeLimitName: normalizeLimitName,
  _normalizeResetAt: normalizeResetAt,
};
