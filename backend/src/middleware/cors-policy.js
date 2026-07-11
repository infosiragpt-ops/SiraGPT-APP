/**
 * cors-policy — pure functions that resolve the CORS allowlist from
 * environment variables and decide which incoming `Origin` headers
 * are accepted.
 *
 * Why this exists as its own module:
 *   The express middleware setup in index.js was a single closure that
 *   couldn't be unit-tested in isolation. Extracting two pure helpers
 *   means we can verify the fail-closed-in-production behavior, the
 *   localhost dev fallback, and the per-origin allow/deny decision
 *   without booting the whole server.
 *
 * Behavior:
 *   - `CORS_ORIGINS=a.com,b.com` → allowlist = ['a.com', 'b.com'].
 *   - `CORS_ORIGINS=*` → explicitly allow every browser origin outside
 *     production. Production-like environments reject this credentialed
 *     wildcard configuration at startup and runtime.
 *   - Empty CORS_ORIGINS in production → startup error. Production must
 *     provide an explicit allowlist; no product-domain fallback is applied.
 *   - Empty CORS_ORIGINS outside production → localhost:3000 / 3001
 *     fallback so `npm run dev` works without further config.
 *   - No `Origin` header on the request (curl, server-to-server, same-
 *     origin) → always allowed; cors's own logic skips the response
 *     header in that case.
 */

const {
  isInvalidEnvironmentAlias,
  isProductionLike,
} = require('../utils/environment');

const DEV_FALLBACK = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

/**
 * Validate that each entry in the resolved allowlist is either the wildcard
 * `*` or a parseable absolute origin (scheme + host, no path/query). Throws
 * a descriptive Error at boot if any value is malformed so misconfiguration
 * fails loudly instead of silently producing an unreachable allowlist.
 */
function validateAllowedOrigins(list) {
  const normalized = [];
  for (const entry of list) {
    if (entry === '*') {
      normalized.push(entry);
      continue;
    }
    let parsed;
    try {
      parsed = new URL(entry);
    } catch (err) {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": not a parseable URL (${err.message}). `
        + 'Expected form: https://example.com (no trailing path/query).'
      );
    }
    if (!parsed.protocol || !parsed.host) {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": missing scheme or host.`
      );
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": only http:// or https:// allowed, got "${parsed.protocol}".`
      );
    }
    if (parsed.username || parsed.password) {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": credentials are not allowed in origins.`
      );
    }
    if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": must be bare origin without path (got pathname "${parsed.pathname}").`
      );
    }
    if (parsed.search || parsed.hash) {
      throw new Error(
        `[cors-policy] Invalid CORS_ORIGINS entry "${entry}": must be bare origin without query or hash.`
      );
    }
    normalized.push(parsed.origin);
  }
  return [...new Set(normalized)];
}

/**
 * Parse REPLIT_DOMAINS (comma-separated bare hostnames Replit sets at
 * runtime, e.g. "siragpt.replit.app,custom.com") into https:// origins
 * so the published *.replit.app URL is always allowed without manual config.
 */
function resolveReplitOrigins(env = process.env) {
  const raw = String(env.REPLIT_DOMAINS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((host) => `https://${host}`);
}

/**
 * The sibling origin that serves codex live previews (CODEX_PREVIEW_ORIGIN).
 * ES-module sub-resource fetches from a generated app carry an `Origin`
 * header equal to that origin; without this the strict CORS callback throws
 * a 500 on @vite/client / main.tsx and the preview stays blank. Always
 * allowed (it is our own controlled proxy host).
 */
function resolvePreviewOrigin(env = process.env) {
  const raw = String(env.CODEX_PREVIEW_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(raw)) return [];
  try { return [new URL(raw).origin]; } catch { return []; }
}

function hasWildcardOrigin(value) {
  return String(value || '')
    .split(',')
    .some((origin) => origin.trim() === '*');
}

function resolveAllowedOrigins(env = process.env) {
  const list = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (isInvalidEnvironmentAlias(env)) {
    const error = new Error('NODE_ENV uses an unsupported environment alias.');
    error.code = 'NODE_ENV_INVALID_ALIAS';
    throw error;
  }
  const production = isProductionLike(env);

  if (production && list.includes('*')) {
    const error = new Error(
      'Credentialed CORS cannot use a wildcard origin in production.',
    );
    error.code = 'CORS_WILDCARD_CREDENTIALS_FORBIDDEN';
    throw error;
  }

  // Always merge in Replit-provided domains (*.replit.app and custom domains
  // set by the platform) so the published app never hits a CORS wall, plus
  // the codex preview origin (its apps fetch modules with that Origin).
  const replitOrigins = resolveReplitOrigins(env);
  const previewOrigins = resolvePreviewOrigin(env);

  if (list.length > 0) {
    const merged = [...new Set([...list, ...replitOrigins, ...previewOrigins])];
    try {
      return validateAllowedOrigins(merged);
    } catch (cause) {
      if (!production) throw cause;
      const error = new Error('Production CORS_ORIGINS contains an invalid origin.');
      error.code = 'CORS_ORIGINS_INVALID';
      throw error;
    }
  }
  if (production) {
    const error = new Error('Production requires an explicit CORS_ORIGINS allowlist.');
    error.code = 'CORS_ORIGINS_REQUIRED';
    throw error;
  }
  return [...new Set([...DEV_FALLBACK, ...previewOrigins])];
}

function makeOriginCallback(allowed) {
  const allowSet = new Set(allowed);
  const allowAnyOrigin = allowSet.has('*');
  return (origin, callback) => {
    // No Origin header → not a browser cross-origin request. Allow
    // through; cors's own logic skips the response header anyway.
    if (!origin) return callback(null, true);
    if (allowAnyOrigin) return callback(null, true);
    if (allowSet.has(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin not allowed (${origin})`));
  };
}

function createCredentialedCorsOptions(allowed) {
  return {
    origin: makeOriginCallback(allowed),
    credentials: true,
    optionsSuccessStatus: 200,
  };
}

module.exports = {
  createCredentialedCorsOptions,
  resolveAllowedOrigins,
  makeOriginCallback,
  validateAllowedOrigins,
  resolvePreviewOrigin,
  hasWildcardOrigin,
  DEV_FALLBACK,
};
