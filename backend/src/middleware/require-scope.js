'use strict';

/**
 * require-scope.js — Cycle 88 API-key scope enforcement.
 *
 * Returns an Express middleware that ensures the authenticated API key
 * carries the `needed` scope (or the wildcard `*`). JWT-authenticated
 * sessions (req.authMethod !== 'api_key') bypass the check entirely —
 * preserving existing behaviour for the browser SPA.
 *
 * Common scope conventions: 'read', 'write', 'admin', plus colon-
 * namespaced fine-grained scopes such as 'ai:generate', 'files:write',
 * 'chats:read'. The wildcard '*' grants all scopes.
 *
 * Also increments the `siragpt_api_key_requests_total{prefix}` counter
 * for each authenticated API-key request that passes through the
 * middleware (regardless of whether the scope check passes). Counter
 * increments are best-effort and never throw.
 *
 * Ratchet 45 — also samples successful requireScope() calls (1-in-50
 * by default) and fire-and-forget updates `ApiKey.usedScopes` with a
 * per-scope `{ count, lastUsedAt }` aggregate. The sampler keeps DB
 * load negligible while still surfacing "which scopes does this key
 * actually use?" for ops/audit.
 *
 * Ratchet 45 (Task 2) — the same sampler also populates a sibling
 * `usedEndpoints` JSON shaped as `{ "<METHOD> <pathPattern>": count }`
 * so operators can see *which routes* a given API key actually exercises
 * (and which scopes are tied to which routes). The path pattern is the
 * Express-matched route template (e.g. `/api/orgs/:id/api-keys`) — never
 * the raw URL — so cardinality stays bounded.
 */

const USED_SCOPE_SAMPLE_RATE = (() => {
  const raw = Number.parseInt(process.env.SIRAGPT_USED_SCOPE_SAMPLE_RATE || '50', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
})();
// Per-process counter so the 1-in-N sampling is deterministic across
// requests served by the same worker. Reset is exposed for tests.
let _sampleCounter = 0;
function _shouldSample() {
  _sampleCounter += 1;
  return _sampleCounter % USED_SCOPE_SAMPLE_RATE === 0;
}
function _resetSampleCounterForTests() { _sampleCounter = 0; }

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

/**
 * Fire-and-forget per-scope last-used aggregate. Reads the current
 * `usedScopes` JSON, bumps the entry for `scope`, writes it back. Errors
 * are swallowed — this must never block the request.
 */
function _recordScopeUsage(prisma, keyId, scope, endpointKey) {
  if (!prisma || !keyId || !scope) return;
  Promise.resolve()
    .then(async () => {
      const row = await prisma.apiKey.findUnique({
        where: { id: keyId },
        select: { usedScopes: true, usedEndpoints: true },
      });
      const current = (row && row.usedScopes && typeof row.usedScopes === 'object')
        ? { ...row.usedScopes }
        : {};
      const prev = current[scope] && typeof current[scope] === 'object' ? current[scope] : {};
      const prevCount = Number.isFinite(prev.count) ? prev.count : 0;
      current[scope] = {
        count: prevCount + USED_SCOPE_SAMPLE_RATE, // upscale to approximate true total
        lastUsedAt: new Date().toISOString(),
      };

      // Ratchet 45 (Task 2) — same sampler, sibling histogram keyed by
      // "METHOD pathPattern". Skipped if the route template isn't
      // available (middleware-level reject before route match) to keep
      // the JSON shape predictable for readers.
      const data = { usedScopes: current };
      if (endpointKey) {
        const endpoints = (row && row.usedEndpoints && typeof row.usedEndpoints === 'object')
          ? { ...row.usedEndpoints }
          : {};
        const prevEpCount = Number.isFinite(endpoints[endpointKey]) ? endpoints[endpointKey] : 0;
        endpoints[endpointKey] = prevEpCount + USED_SCOPE_SAMPLE_RATE; // same upscale
        data.usedEndpoints = endpoints;
      }

      await prisma.apiKey.update({
        where: { id: keyId },
        data,
      });
    })
    .catch(() => { /* never break the request */ });
}

// Best-effort, low-cardinality endpoint label — Express's matched route
// template (never the raw URL). Returns null when no route matched yet.
function _endpointKey(req) {
  if (!req) return null;
  const matched = req.route && req.route.path;
  if (!matched) return null;
  const base = req.baseUrl || '';
  const path = `${base}${matched}` || matched;
  const method = (req.method || 'GET').toUpperCase();
  return `${method} ${path}`;
}

let _metrics = null;
function getMetrics() {
  if (_metrics !== null) return _metrics;
  try {
    // Lazy require so test environments without metrics keep working.
    // eslint-disable-next-line global-require
    _metrics = require('../utils/metrics');
    if (_metrics && typeof _metrics.registerCounter === 'function') {
      _metrics.registerCounter('siragpt_api_key_requests_total', {
        help: 'Total authenticated requests served using an API key, labelled by key prefix',
        labels: ['prefix'],
      });
    }
  } catch (_err) {
    _metrics = false;
  }
  return _metrics;
}

function trackApiKeyRequest(prefix) {
  const m = getMetrics();
  if (!m || typeof m.counter !== 'function') return;
  try {
    m.counter('siragpt_api_key_requests_total', { prefix: prefix || 'unknown' }, 1);
  } catch (_err) {
    /* never break the request on metrics */
  }
}

function hasScope(scopes, needed) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  if (scopes.includes('*')) return true;
  if (scopes.includes(needed)) return true;
  // Allow a colon-namespace wildcard such as 'ai:*' covering 'ai:generate'.
  const colon = needed.indexOf(':');
  if (colon > 0) {
    const ns = needed.slice(0, colon) + ':*';
    if (scopes.includes(ns)) return true;
  }
  return false;
}

function requireScope(needed) {
  if (typeof needed !== 'string' || !needed) {
    throw new TypeError('requireScope(needed): needed must be a non-empty string');
  }
  return function requireScopeMiddleware(req, res, next) {
    // JWT (or anonymous) sessions bypass scope enforcement entirely.
    if (req.authMethod !== 'api_key') return next();

    const apiKey = req.apiKey || {};
    trackApiKeyRequest(apiKey.prefix);

    if (!hasScope(apiKey.scopes, needed)) {
      return res.status(403).json({
        error: 'insufficient_scope',
        message: `API key is missing required scope '${needed}'`,
        required: needed,
      });
    }

    // Sampled per-scope last-used aggregate. Fire-and-forget.
    if (apiKey.id && _shouldSample()) {
      const prisma = _getPrisma();
      if (prisma && prisma.apiKey && typeof prisma.apiKey.update === 'function') {
        _recordScopeUsage(prisma, apiKey.id, needed, _endpointKey(req));
      }
    }

    return next();
  };
}

module.exports = {
  requireScope,
  hasScope,
  _resetSampleCounterForTests,
  USED_SCOPE_SAMPLE_RATE,
};
