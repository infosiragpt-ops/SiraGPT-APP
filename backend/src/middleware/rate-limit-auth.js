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

function pickIp(req) {
  return (
    req.ip
    || (req.headers && req.headers['x-forwarded-for'])
    || (req.connection && req.connection.remoteAddress)
    || 'unknown'
  );
}

function pickEmail(req) {
  const raw = req.body && (req.body.email || req.body.username);
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().slice(0, 254);
}

function resolveKey(req, keyBy, name) {
  if (typeof keyBy === 'function') {
    try {
      const k = keyBy(req);
      if (typeof k === 'string' && k.length > 0) return `authrl:${name}:${k}`;
    } catch (_) { /* fall through */ }
  }
  if (keyBy === 'ip+email') {
    const email = pickEmail(req);
    return `authrl:${name}:${pickIp(req)}:${email || 'noemail'}`;
  }
  return `authrl:${name}:${pickIp(req)}`;
}

function makeAuthRateLimit(opts = {}) {
  const name = String(opts.name || 'generic').trim() || 'generic';
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
      if (!result.allowed) {
        const retryAfterMs = Math.max(0, result.resetAt.getTime() - Date.now());
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        res.set('Retry-After', String(retryAfterSec));
        res.set('RateLimit-Limit', String(limit));
        res.set('RateLimit-Remaining', '0');
        res.set('RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));
        return res.status(429).json({
          error: `Too many ${name} attempts. Please try again later.`,
          retryAfterMs,
        });
      }
      // Surface remaining for debugging + clients that want to back off
      // proactively rather than be 429'd.
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(Math.max(0, result.remaining)));
      res.set('RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));
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
};
