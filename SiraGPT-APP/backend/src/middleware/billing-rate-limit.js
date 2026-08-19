'use strict';

const net = require('node:net');
const rateLimitStore = require('./rate-limit-store');
const {
  resolveSensitiveRateLimitPolicy,
  resolveStoreRetryAfterSeconds,
} = require('./rate-limit-policy');
const {
  _normalizeKeySegment: normalizeKeySegment,
  _normalizeLimitName: normalizeLimitName,
  _pickIp: pickIp,
} = require('./rate-limit-auth');
const { getRequestId } = require('./request-id');

function setHeader(res, name, value) {
  if (res && typeof res.setHeader === 'function') res.setHeader(name, value);
}

function setNoStoreHeaders(res) {
  setHeader(res, 'Cache-Control', 'no-store');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
}

function normalizeResetAt(value, windowMs) {
  const resetAt = value instanceof Date ? value : new Date(value);
  return Number.isFinite(resetAt.getTime())
    ? resetAt
    : new Date(Date.now() + windowMs);
}

function retryAfter(resetAt) {
  return Math.max(1, Math.ceil(Math.max(0, resetAt.getTime() - Date.now()) / 1000));
}

function expandIpv6(address) {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const last = parts[parts.length - 1];
    if (last && last.includes('.')) {
      if (net.isIP(last) !== 4) return null;
      const octets = last.split('.').map(Number);
      parts.splice(
        parts.length - 1,
        1,
        ((octets[0] << 8) | octets[1]).toString(16),
        ((octets[2] << 8) | octets[3]).toString(16),
      );
    }
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
    return parts.map((part) => parseInt(part, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function normalizeBillingIp(value) {
  let raw = String(value || '').trim();
  if (!raw || raw.length > 128 || /[\r\n\0,]/.test(raw)) return 'unknown';
  const zoneIndex = raw.indexOf('%');
  if (zoneIndex >= 0) raw = raw.slice(0, zoneIndex);

  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped && net.isIP(mapped[1]) === 4) {
    return mapped[1].split('.').map((part) => String(Number(part))).join('.');
  }
  if (net.isIP(raw) === 4) {
    return raw.split('.').map((part) => String(Number(part))).join('.');
  }
  if (net.isIP(raw) !== 6) return 'unknown';
  const expanded = expandIpv6(raw);
  if (!expanded) return 'unknown';
  return `${expanded.slice(0, 4).map((part) => part.toString(16)).join(':')}::/64`;
}

function makeBillingRateLimit(opts = {}) {
  const name = normalizeLimitName(opts.name || 'billing');
  const limit = Number(opts.limit);
  const ipLimit = Number(opts.ipLimit ?? limit * 10);
  const windowMs = Number(opts.windowMs);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('makeBillingRateLimit: opts.limit must be a positive number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('makeBillingRateLimit: opts.windowMs must be a positive number');
  }
  if (!Number.isFinite(ipLimit) || ipLimit < limit) {
    throw new TypeError('makeBillingRateLimit: opts.ipLimit must be at least opts.limit');
  }

  const store = opts.store || rateLimitStore;
  const env = opts.env || process.env;
  const policy = resolveSensitiveRateLimitPolicy(env);
  const consumeEnv = policy.mode === 'memory'
    ? { ...env, RATE_LIMIT_STORE: 'memory' }
    : env;

  const middleware = async function billingRateLimit(req, res, next) {
    const userId = normalizeKeySegment(req && req.user && req.user.id, {
      label: 'user',
      fallback: 'unknown',
    });
    const ip = normalizeKeySegment(normalizeBillingIp(pickIp(req || {})), {
      label: 'ip',
      fallback: 'unknown',
    });
    const keys = [
      `billingrl:${name}:user:${userId}`,
      `billingrl:${name}:ip:${ip}`,
    ];

    try {
      const result = await store.consumeMany(keys, limit, windowMs, {
        env: consumeEnv,
        limits: [limit, ipLimit],
        requireDistributed: policy.requireDistributed,
      });
      if (result && result.allowed === false) {
        const resetAt = normalizeResetAt(result.resetAt, windowMs);
        const retryAfterSec = retryAfter(resetAt);
        setNoStoreHeaders(res);
        setHeader(res, 'RateLimit-Limit', String(limit));
        setHeader(res, 'RateLimit-Remaining', '0');
        setHeader(res, 'RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
        setHeader(res, 'Retry-After', String(retryAfterSec));
        return res.status(429).json({
          ok: false,
          code: 'billing_rate_limited',
          error: 'Too many billing operations. Please try again later.',
          retryAfterSec,
          ...(getRequestId(req) ? { requestId: getRequestId(req) } : {}),
        });
      }

      const remaining = Math.max(0, Number(result && result.remaining) || 0);
      const resetAt = normalizeResetAt(result && result.resetAt, windowMs);
      setHeader(res, 'RateLimit-Limit', String(limit));
      setHeader(res, 'RateLimit-Remaining', String(remaining));
      setHeader(res, 'RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
      return next();
    } catch (_error) {
      if (!policy.failClosed) return next();
      const retryAfterSeconds = resolveStoreRetryAfterSeconds(
        _error,
        policy.retryAfterSeconds,
      );
      setNoStoreHeaders(res);
      setHeader(res, 'Retry-After', String(retryAfterSeconds));
      return res.status(503).json({
        ok: false,
        code: rateLimitStore.RATE_LIMIT_STORE_UNAVAILABLE,
        error: 'Rate limit service temporarily unavailable.',
        retryAfterSec: retryAfterSeconds,
        ...(getRequestId(req) ? { requestId: getRequestId(req) } : {}),
      });
    }
  };
  middleware.rateLimitAction = name;
  middleware.rateLimitUserLimit = limit;
  middleware.rateLimitIpLimit = ipLimit;
  return middleware;
}

module.exports = {
  makeBillingRateLimit,
  normalizeBillingIp,
};
