'use strict';

const crypto = require('crypto');

const WINDOW_MS = Number.parseInt(process.env.SIRAGPT_RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = Number.parseInt(process.env.SIRAGPT_RATE_LIMIT_MAX || '60', 10);

const stores = new Map();

class RateLimiter {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || WINDOW_MS;
    this.maxRequests = opts.maxRequests || MAX_REQUESTS;
    this.keyPrefix = opts.keyPrefix || 'rl';
    this.store = opts.store || new Map();
  }

  _getKey(identifier) {
    return `${this.keyPrefix}:${identifier}`;
  }

  check(identifier) {
    const key = this._getKey(identifier);
    const now = Date.now();

    let bucket = this.store.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      bucket = { windowStart: now, count: 0, blocked: 0 };
      this.store.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > this.maxRequests) {
      bucket.blocked++;
      const resetIn = Math.max(0, this.windowMs - (now - bucket.windowStart));
      return {
        allowed: false,
        remaining: 0,
        limit: this.maxRequests,
        resetIn,
        retryAfterMs: resetIn,
      };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - bucket.count,
      limit: this.maxRequests,
      resetIn: Math.max(0, this.windowMs - (now - bucket.windowStart)),
    };
  }

  reset(identifier) {
    const key = this._getKey(identifier);
    return this.store.delete(key);
  }

  getStats(identifier) {
    const key = this._getKey(identifier);
    const bucket = this.store.get(key);
    if (!bucket) {
      return { count: 0, blocked: 0, windowStart: null };
    }
    return {
      count: bucket.count,
      blocked: bucket.blocked,
      windowStart: bucket.windowStart,
    };
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, bucket] of this.store) {
      if (now - bucket.windowStart > this.windowMs * 2) {
        this.store.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

const defaultLimiter = new RateLimiter();

const userLimiters = new Map();

function getUserLimiter(userId, opts = {}) {
  if (!userLimiters.has(userId)) {
    userLimiters.set(userId, new RateLimiter({
      windowMs: opts.windowMs || WINDOW_MS,
      maxRequests: opts.maxRequests || MAX_REQUESTS,
      keyPrefix: `user:${userId}`,
    }));
  }
  return userLimiters.get(userId);
}

const ENDPOINT_LIMITS = {
  '/api/ai/generate': { windowMs: 60000, maxRequests: 30 },
  '/api/agent/task': { windowMs: 60000, maxRequests: 10 },
  '/api/cowork/auto-file': { windowMs: 60000, maxRequests: 30 },
  '/api/cowork/analyze-deep': { windowMs: 60000, maxRequests: 20 },
  '/api/cowork/memory': { windowMs: 60000, maxRequests: 60 },
  '/api/cowork/sessions': { windowMs: 60000, maxRequests: 30 },
  '/api/files/upload': { windowMs: 60000, maxRequests: 20 },
  '/api/rag/ingest': { windowMs: 60000, maxRequests: 15 },
};

const endpointLimiters = new Map();

function getEndpointLimiter(endpoint) {
  if (!endpointLimiters.has(endpoint)) {
    const config = ENDPOINT_LIMITS[endpoint];
    if (!config) return null;
    endpointLimiters.set(endpoint, new RateLimiter({
      ...config,
      keyPrefix: `ep:${endpoint}`,
    }));
  }
  return endpointLimiters.get(endpoint);
}

function rateLimitMiddleware(opts = {}) {
  const limiter = new RateLimiter(opts);

  return (req, res, next) => {
    const identifier = req.user?.id || req.ip || 'anonymous';
    const result = limiter.check(identifier);

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.round((Date.now() + result.resetIn) / 1000)));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please try again later.',
        retryAfterMs: result.retryAfterMs,
      });
    }

    next();
  };
}

let cleanupTimer = null;
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    defaultLimiter.cleanup();
    for (const limiter of userLimiters.values()) limiter.cleanup();
    for (const limiter of endpointLimiters.values()) limiter.cleanup();
  }, 5 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}
startCleanup();

module.exports = {
  RateLimiter,
  defaultLimiter,
  getUserLimiter,
  getEndpointLimiter,
  rateLimitMiddleware,
  ENDPOINT_LIMITS,
};
