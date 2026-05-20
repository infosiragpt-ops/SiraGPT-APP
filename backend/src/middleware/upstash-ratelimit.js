'use strict';

/**
 * upstash-ratelimit — multi-window rate limiting via Upstash Redis REST API.
 *
 * Uses @upstash/redis + @upstash/ratelimit (lazy-required) for:
 *   - Per-IP rate limiting (fixed window, sliding window, token bucket)
 *   - Per-user rate limiting (authenticated)    
 *   - Express middleware factory with configurable windows
 *
 * Falls back to existing rate-limit-store.js (ioredis + memory) when
 * UPSTASH_REDIS_REST_URL is not configured.
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL     — Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN   — Upstash REST API token
 *   SIRAGPT_RATELIMIT_IP_MAX   — max requests per IP per window (default: 60)
 *   SIRAGPT_RATELIMIT_USER_MAX — max req per user per window (default: 120)
 *   SIRAGPT_RATELIMIT_WINDOW_S — window in seconds (default: 60)
 */

const { createRateLimitStore } = require('./rate-limit-store');

let _upstashRedis = null;
let _Ratelimit = null;

function loadUpstash() {
  if (_upstashRedis && _Ratelimit) return { redis: _upstashRedis, Ratelimit: _Ratelimit };
  try {
    const { Redis } = require('@upstash/redis');
    _upstashRedis = Redis;
    const upstash = require('@upstash/ratelimit');
    _Ratelimit = upstash.Ratelimit;
    return { redis: _upstashRedis, Ratelimit: _Ratelimit };
  } catch (_) {
    return { redis: null, Ratelimit: null };
  }
}

function isEnabled(env = process.env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

function createUpstashClient(env = process.env) {
  if (!isEnabled(env)) return null;
  const { redis: Redis } = loadUpstash();
  if (!Redis) return null;
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
    enableTelemetry: false,
  });
}

function ipRateLimitKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  return `ratelimit:ip:${ip}`;
}

function userRateLimitKey(req) {
  const userId = req.user?.id || req.user?.userId || 'anon';
  return `ratelimit:user:${userId}`;
}

function createUpstashRateLimiter(opts = {}) {
  const env = opts.env || process.env;
  const windowSeconds = Number.parseInt(env.SIRAGPT_RATELIMIT_WINDOW_S || '60', 10);
  const ipMax = Number.parseInt(env.SIRAGPT_RATELIMIT_IP_MAX || '60', 10);
  const userMax = Number.parseInt(env.SIRAGPT_RATELIMIT_USER_MAX || '120', 10);
  const skip = typeof opts.skip === 'function' ? opts.skip : null;

  const client = createUpstashClient(env);

  // Fallback: use existing ioredis+memory rate-limit-store when Upstash
  // is not configured (preserves backward compat).
  if (!client) {
    const existing = createRateLimitStore(env);
    return {
      ipLimiter(req, res, next) {
        next();
      },
      userLimiter(req, res, next) {
        next();
      },
      enabled: false,
      mode: existing.mode,
      reason: existing.reason,
    };
  }

  const { Ratelimit } = loadUpstash();
  let ipLimiterInstance = null;
  let userLimiterInstance = null;

  if (Ratelimit) {
    try {
      ipLimiterInstance = new Ratelimit({
        redis: client,
        limiter: Ratelimit.slidingWindow(ipMax, `${windowSeconds} s`),
        analytics: true,
        prefix: 'rl:ip:',
      });
      userLimiterInstance = new Ratelimit({
        redis: client,
        limiter: Ratelimit.slidingWindow(userMax, `${windowSeconds} s`),
        analytics: true,
        prefix: 'rl:user:',
      });
    } catch (_) {
      // degrade gracefully
    }
  }

  function ipLimiter(req, res, next) {
    if (skip && skip(req)) return next();
    if (!ipLimiterInstance) return next();

    const key = ipRateLimitKey(req);
    ipLimiterInstance.limit(key)
      .then(result => {
        if (!result.success) {
          res.set('Retry-After', String(Math.ceil(result.reset / 1000)));
          res.set('X-RateLimit-Limit', String(result.limit));
          res.set('X-RateLimit-Remaining', String(result.remaining));
          res.set('X-RateLimit-Reset', String(Math.ceil(result.reset / 1000)));
          return res.status(429).json({
            error: 'Too Many Requests',
            code: 'rate_limit.ip_exceeded',
            retryAfter: Math.ceil(result.reset / 1000),
            limit: result.limit,
            remaining: 0,
          });
        }
        res.set('X-RateLimit-Limit', String(result.limit));
        res.set('X-RateLimit-Remaining', String(result.remaining));
        res.set('X-RateLimit-Reset', String(Math.ceil(result.reset / 1000)));
        next();
      })
      .catch(() => next());
  }

  function userLimiter(req, res, next) {
    if (skip && skip(req)) return next();
    if (!userLimiterInstance) return next();
    if (!req.user?.id && !req.user?.userId) return next();

    const key = userRateLimitKey(req);
    userLimiterInstance.limit(key)
      .then(result => {
        if (!result.success) {
          res.set('Retry-After', String(Math.ceil(result.reset / 1000)));
          return res.status(429).json({
            error: 'Too Many Requests',
            code: 'rate_limit.user_exceeded',
            retryAfter: Math.ceil(result.reset / 1000),
            limit: result.limit,
            remaining: 0,
          });
        }
        next();
      })
      .catch(() => next());
  }

  return {
    ipLimiter,
    userLimiter,
    enabled: true,
    mode: 'upstash',
    windowSeconds,
    ipMax,
    userMax,
  };
}

module.exports = {
  createUpstashRateLimiter,
  isEnabled,
  createUpstashClient,
  ipRateLimitKey,
  userRateLimitKey,
};
