'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { requestPath } = require('./stripe-webhook-ingress');
const rateLimitStore = require('./rate-limit-store');
const {
  resolveSensitiveRateLimitPolicy,
  resolveStoreRetryAfterSeconds,
} = require('./rate-limit-policy');
const {
  _pickIp: pickIp,
} = require('./rate-limit-auth');
const {
  normalizeBillingIp,
} = require('./billing-rate-limit');

const SAML_ACS_PATH_RE =
  /^\/api\/auth\/sso\/[a-z0-9][a-z0-9-]{0,127}\/callback$/i;
const MIN_SAML_ACS_BODY_LIMIT_BYTES = 64 * 1024;
const SAML_ACS_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_SAML_ACS_BODY_LIMIT_BYTES = 512 * 1024;
const DEFAULT_SAML_ACS_RATE_LIMIT_MAX = 30;
const DEFAULT_SAML_ACS_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveSamlAcsBodyLimit(env = process.env) {
  return clampInteger(
    env.SAML_ACS_BODY_LIMIT_BYTES,
    SAML_ACS_BODY_LIMIT_BYTES,
    MIN_SAML_ACS_BODY_LIMIT_BYTES,
    MAX_SAML_ACS_BODY_LIMIT_BYTES,
  );
}

function resolveSamlAcsRateLimit(env = process.env) {
  return Object.freeze({
    limit: clampInteger(
      env.SAML_ACS_RATE_LIMIT_MAX,
      DEFAULT_SAML_ACS_RATE_LIMIT_MAX,
      1,
      1_000,
    ),
    windowMs: clampInteger(
      env.SAML_ACS_RATE_LIMIT_WINDOW_MS,
      DEFAULT_SAML_ACS_RATE_LIMIT_WINDOW_MS,
      1_000,
      15 * 60 * 1000,
    ),
  });
}

function isExactSamlAcsPath(req) {
  return String(req?.method || '').toUpperCase() === 'POST'
    && SAML_ACS_PATH_RE.test(requestPath(req));
}

function hasSamlAcsBody(req) {
  return typeof req?.body?.SAMLResponse === 'string'
    && req.body.SAMLResponse.trim().length > 0;
}

function createSamlAcsBodyParser(options = {}) {
  const env = options.env || process.env;
  const parseUrlencoded = express.urlencoded({
    extended: false,
    limit: resolveSamlAcsBodyLimit(env),
    parameterLimit: 10,
    type: 'application/x-www-form-urlencoded',
  });

  return function samlAcsBodyParser(req, res, next) {
    if (!isExactSamlAcsPath(req)) return next();
    return parseUrlencoded(req, res, next);
  };
}

function setHeader(res, name, value) {
  if (typeof res?.setHeader === 'function') res.setHeader(name, value);
  else if (typeof res?.set === 'function') res.set(name, value);
}

function setBlockedHeaders(res, retryAfterSeconds) {
  setHeader(res, 'Cache-Control', 'no-store');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  setHeader(res, 'Retry-After', String(retryAfterSeconds));
}

function normalizeResetAt(value, windowMs) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed
    : new Date(Date.now() + windowMs);
}

function acsRateLimitKey(req) {
  const ip = normalizeBillingIp(pickIp(req || {}));
  const digest = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  return `saml-acs:${digest}`;
}

function createSamlAcsRateLimit(options = {}) {
  const env = options.env || process.env;
  const store = options.store || rateLimitStore;
  const policy = resolveSensitiveRateLimitPolicy(env);
  const consumeEnv = policy.mode === 'memory'
    ? { ...env, RATE_LIMIT_STORE: 'memory' }
    : env;
  const { limit, windowMs } = resolveSamlAcsRateLimit(env);

  return async function samlAcsRateLimit(req, res, next) {
    if (!isExactSamlAcsPath(req)) return next();
    try {
      const result = await store.consume(acsRateLimitKey(req), limit, windowMs, {
        env: consumeEnv,
        requireDistributed: policy.requireDistributed,
      });
      const resetAt = normalizeResetAt(result?.resetAt, windowMs);
      if (result?.allowed === false) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(Math.max(0, resetAt.getTime() - Date.now()) / 1000),
        );
        setBlockedHeaders(res, retryAfterSeconds);
        setHeader(res, 'RateLimit-Limit', String(limit));
        setHeader(res, 'RateLimit-Remaining', '0');
        setHeader(res, 'RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
        return res.status(429).json({
          ok: false,
          code: 'saml_acs_rate_limited',
          error: 'Too many SAML callback attempts. Please try again later.',
          retryAfterSec: retryAfterSeconds,
        });
      }
      setHeader(res, 'RateLimit-Limit', String(limit));
      setHeader(res, 'RateLimit-Remaining', String(Math.max(0, Number(result?.remaining) || 0)));
      setHeader(res, 'RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
      return next();
    } catch (error) {
      const retryAfterSeconds = resolveStoreRetryAfterSeconds(
        error,
        policy.retryAfterSeconds,
      );
      setBlockedHeaders(res, retryAfterSeconds);
      return res.status(503).json({
        ok: false,
        code: rateLimitStore.RATE_LIMIT_STORE_UNAVAILABLE,
        error: 'Rate limit service temporarily unavailable.',
        retryAfterSec: retryAfterSeconds,
      });
    }
  };
}

function createSamlAcsCorsMiddleware(globalCors) {
  if (typeof globalCors !== 'function') {
    throw new TypeError('createSamlAcsCorsMiddleware requires CORS middleware');
  }

  return function samlAcsCors(req, res, next) {
    if (isExactSamlAcsPath(req) && hasSamlAcsBody(req)) return next();
    return globalCors(req, res, next);
  };
}

module.exports = {
  DEFAULT_SAML_ACS_RATE_LIMIT_MAX,
  DEFAULT_SAML_ACS_RATE_LIMIT_WINDOW_MS,
  MAX_SAML_ACS_BODY_LIMIT_BYTES,
  MIN_SAML_ACS_BODY_LIMIT_BYTES,
  SAML_ACS_BODY_LIMIT_BYTES,
  SAML_ACS_PATH_RE,
  createSamlAcsBodyParser,
  createSamlAcsCorsMiddleware,
  createSamlAcsRateLimit,
  hasSamlAcsBody,
  isExactSamlAcsPath,
  resolveSamlAcsBodyLimit,
  resolveSamlAcsRateLimit,
};
