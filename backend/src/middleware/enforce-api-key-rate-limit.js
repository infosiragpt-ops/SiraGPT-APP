'use strict';

/**
 * enforce-api-key-rate-limit.js — Ratchet 45 per-key rate limiter.
 *
 * Applies a sliding-window cap to every authenticated API-key request.
 * Limit resolution order:
 *
 *   1. `apiKey.rateLimitPerMinute` (per-key override on the ApiKey row)
 *   2. Plan-derived default from the owning user / organization plan
 *      (FREE / PRO / ENTERPRISE → env-tunable RPM caps)
 *   3. Hard fallback (`SIRAGPT_API_KEY_DEFAULT_RPM`, default 60)
 *
 * The middleware is a no-op for JWT/session traffic (req.authMethod
 * !== 'api_key'). When the rate-limit store throws, the request is
 * allowed through (fail-open) — same posture as enforce-org-rate-limit.
 *
 * Also emits a sampled audit-log row every Nth use of the same key
 * (env `SIRAGPT_API_KEY_AUDIT_SAMPLE_RATE`, default 100) with
 * action='api_key_used'. The counter is per-process and deterministic
 * — the parent of `audit-log.js` swallows write errors, so this never
 * blocks the request.
 */

const rateLimitStore = require('./rate-limit-store');
const { getRequestId } = require('./request-id');

const WINDOW_MS = 60_000;

const HEADER_LIMIT = 'X-API-Key-RateLimit-Limit';
const HEADER_REMAINING = 'X-API-Key-RateLimit-Remaining';
const HEADER_RESET = 'X-API-Key-RateLimit-Reset';
const HEADER_SOURCE = 'X-API-Key-RateLimit-Source';

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function defaultRpmForPlan(plan) {
  const RPM_FREE = envInt('SIRAGPT_API_KEY_RPM_FREE', 60);
  const RPM_PRO = envInt('SIRAGPT_API_KEY_RPM_PRO', 600);
  const RPM_ENT = envInt('SIRAGPT_API_KEY_RPM_ENT', 6000);
  const HARD = envInt('SIRAGPT_API_KEY_DEFAULT_RPM', 60);
  switch (String(plan || '').toUpperCase()) {
    case 'ENTERPRISE':
    case 'ENT':
      return RPM_ENT;
    case 'PRO':
    case 'PRO_MAX':
      return RPM_PRO;
    case 'FREE':
      return RPM_FREE;
    default:
      return HARD;
  }
}

function resolvePlan(req) {
  if (req && req.organization && req.organization.billingPlan) {
    return String(req.organization.billingPlan);
  }
  if (req && req.user && req.user.plan) {
    return String(req.user.plan);
  }
  return 'FREE';
}

function resolveLimit(req) {
  const apiKey = req.apiKey || {};
  if (Number.isFinite(apiKey.rateLimitPerMinute) && apiKey.rateLimitPerMinute > 0) {
    return { limit: Math.floor(apiKey.rateLimitPerMinute), source: 'key' };
  }
  const plan = resolvePlan(req);
  return { limit: defaultRpmForPlan(plan), source: `plan:${plan}` };
}

let _failureLogged = false;
function logOnce(msg, err) {
  if (_failureLogged) return;
  _failureLogged = true;
  const detail = err && err.message ? ` (${err.message})` : '';
  // eslint-disable-next-line no-console
  console.warn(`[api-key-rate-limit] ${msg}${detail}`);
}

function setNoStoreHeaders(res) {
  try { res.setHeader('Cache-Control', 'no-store'); } catch (_e) { /* swallow */ }
  try { res.setHeader('X-Content-Type-Options', 'nosniff'); } catch (_e) { /* swallow */ }
}

// ─── Sampled audit-log of API-key usage (Task 2) ────────────────────
const AUDIT_SAMPLE_RATE = (() => {
  const raw = Number.parseInt(process.env.SIRAGPT_API_KEY_AUDIT_SAMPLE_RATE || '100', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();
const _useCounters = new Map(); // keyId → count (per-process)
function _resetAuditCountersForTests() { _useCounters.clear(); }

let _prismaRef = null;
function _getPrisma() {
  if (_prismaRef !== null) return _prismaRef;
  try {
    // eslint-disable-next-line global-require
    _prismaRef = require('../config/database');
  } catch (_err) {
    _prismaRef = false;
  }
  return _prismaRef;
}

let _writeAuditLog = null;
function _getAuditWriter() {
  if (_writeAuditLog !== null) return _writeAuditLog;
  try {
    // eslint-disable-next-line global-require
    _writeAuditLog = require('../utils/audit-log').writeAuditLog;
  } catch (_err) {
    _writeAuditLog = false;
  }
  return _writeAuditLog;
}

function _maybeAuditUse(req, endpoint) {
  const apiKey = req && req.apiKey;
  if (!apiKey || !apiKey.id) return;
  const prev = _useCounters.get(apiKey.id) || 0;
  const next = prev + 1;
  _useCounters.set(apiKey.id, next);
  if (next % AUDIT_SAMPLE_RATE !== 0) return;

  const prisma = _getPrisma();
  const writer = _getAuditWriter();
  if (!prisma || !writer) return;

  // Fire-and-forget — audit-log.writeAuditLog already swallows errors.
  void writer(prisma, {
    req,
    action: 'api_key_used',
    actorType: 'api_key',
    userId: req.user && req.user.id ? req.user.id : null,
    resource: 'api_key',
    resourceId: apiKey.id,
    metadata: {
      keyId: apiKey.id,
      prefix: apiKey.prefix || null,
      scope: Array.isArray(apiKey.scopes) ? apiKey.scopes : [],
      endpoint: endpoint || null,
      sampledEveryNUses: AUDIT_SAMPLE_RATE,
      uses: next,
    },
  });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.store]    — override rate-limit-store (tests)
 * @param {number} [opts.windowMs] — override window length (tests)
 */
function enforceApiKeyRateLimit(opts = {}) {
  const store = opts.store || rateLimitStore;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? Number(opts.windowMs)
    : WINDOW_MS;

  return async function enforceApiKeyRateLimitMiddleware(req, res, next) {
    if (!req || req.authMethod !== 'api_key' || !req.apiKey || !req.apiKey.id) {
      return next();
    }

    const { limit, source } = resolveLimit(req);
    try { res.setHeader(HEADER_LIMIT, String(limit)); } catch (_e) { /* swallow */ }
    try { res.setHeader(HEADER_SOURCE, source); } catch (_e) { /* swallow */ }

    let result;
    try {
      result = await store.consume(`api-key-rpm:${req.apiKey.id}`, limit, windowMs);
    } catch (err) {
      logOnce('rate-limit store failed (fail-open)', err);
      // Audit even when the store hiccups, so forensics still see the use.
      try { _maybeAuditUse(req, req.originalUrl || req.url); } catch (_) { /* swallow */ }
      return next();
    }

    const remaining = Math.max(0, Number(result && result.remaining) || 0);
    try { res.setHeader(HEADER_REMAINING, String(remaining)); } catch (_e) { /* swallow */ }
    const resetAt = result && result.resetAt instanceof Date
      ? result.resetAt.getTime()
      : Date.now() + windowMs;
    try { res.setHeader(HEADER_RESET, String(Math.ceil(resetAt / 1000))); } catch (_e) { /* swallow */ }

    if (result && result.allowed === false) {
      const retryAfterMs = Math.max(0, resetAt - Date.now());
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      setNoStoreHeaders(res);
      try { res.setHeader('Retry-After', String(retryAfterSec)); } catch (_e) { /* swallow */ }
      const requestId = getRequestId(req);
      return res.status(429).json({
        ok: false,
        code: 'api_key_rate_limited',
        error: 'api key rate limit exceeded',
        keyId: req.apiKey.id,
        prefix: req.apiKey.prefix || null,
        limitPerMinute: limit,
        source,
        retryAfterMs,
        retryAfterSec,
        ...(requestId ? { requestId } : {}),
      });
    }

    // Sampled audit-log of api_key_used. Fire-and-forget.
    try { _maybeAuditUse(req, req.originalUrl || req.url); } catch (_) { /* swallow */ }

    return next();
  };
}

module.exports = {
  enforceApiKeyRateLimit,
  defaultRpmForPlan,
  resolveLimit,
  resolvePlan,
  HEADER_LIMIT,
  HEADER_REMAINING,
  HEADER_RESET,
  HEADER_SOURCE,
  AUDIT_SAMPLE_RATE,
  _resetAuditCountersForTests,
};
