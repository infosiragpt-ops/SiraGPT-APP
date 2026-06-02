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
 *   - `CORS_ORIGINS=*` → explicitly allow every browser origin. The
 *     cors package reflects the request origin when the callback
 *     returns `true`, so credentialed local requests still work.
 *   - Empty CORS_ORIGINS in production → empty allowlist (every browser-
 *     issued request rejected). This is the deliberate fail-closed
 *     posture; index.js logs a loud warn at startup so the misconfig
 *     surfaces in the access log.
 *   - Empty CORS_ORIGINS outside production → localhost:3000 / 3001
 *     fallback so `npm run dev` works without further config.
 *   - No `Origin` header on the request (curl, server-to-server, same-
 *     origin) → always allowed; cors's own logic skips the response
 *     header in that case.
 */

const DEV_FALLBACK = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

// Production fallback — known-good public origins for the deployed
// product. Used ONLY when CORS_ORIGINS is unset in production so the
// site doesn't fail closed on a fresh deploy where the operator
// forgot to set the env var. A loud security warning is logged
// at boot in index.js when this fallback is hit.
const PROD_FALLBACK = [
  'https://siragpt.io',
  'https://www.siragpt.io',
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

function resolveAllowedOrigins(env = process.env) {
  const list = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Always merge in Replit-provided domains (*.replit.app and custom domains
  // set by the platform) so the published app never hits a CORS wall.
  const replitOrigins = resolveReplitOrigins(env);

  if (list.length > 0) {
    const merged = [...new Set([...list, ...replitOrigins])];
    return validateAllowedOrigins(merged);
  }
  if (env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  [cors] CORS_ORIGINS env var is unset in production. '
      + `Falling back to safe defaults: ${PROD_FALLBACK.join(', ')}. `
      + 'Set CORS_ORIGINS=https://yourdomain.com to override.'
    );
    const merged = [...new Set([...PROD_FALLBACK, ...replitOrigins])];
    return merged;
  }
  return [...DEV_FALLBACK];
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

module.exports = { resolveAllowedOrigins, makeOriginCallback, validateAllowedOrigins, DEV_FALLBACK, PROD_FALLBACK };
